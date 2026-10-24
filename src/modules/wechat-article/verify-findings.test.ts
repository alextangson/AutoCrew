/**
 * Verifier findings (2026-10-24, full-media E2E run). Each `it` is a reproduced problem; a failing test here is a
 * finding, not a broken test. Do not bend these to pass — fix the product or update the spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

vi.mock("../publish/wechat-mp.js", () => ({ generateWechatImageAsset: vi.fn() }));

import { generateWechatImageAsset } from "../publish/wechat-mp.js";
import { getContent } from "../../storage/local-store.js";
import { makeEnv, png, put, setContent, videoContent, type Env } from "../production/testkit.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { readInbox } from "../production/inbox-read.js";
import { decideItem } from "../production/inbox-decide.js";
import { listForChat } from "../production/chat-approval/present.js";
import { executeWechatArticle } from "../../tools/wechat-article.js";
import { executeContentSave } from "../../tools/content-save.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

const genMock = vi.mocked(generateWechatImageAsset);
let env: Env;
let id: string;
const BODY = `## 开头\n${"字".repeat(2600)}\n\n[IMAGE: gen: 概念示意]\n\n## 第二节\n官方页面长这样\n\n[IMAGE: web: OpenAI 定价页截图]`;
const run = (p: Record<string, unknown>) => executeWechatArticle({ _dataDir: env.dir, content_id: id, ...p });
const draftItem = async () => (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === id);

beforeEach(async () => {
  env = await makeEnv();
  await initProfile(env.dir);
  await updateProfile({ platforms: ["douyin", "wechat_mp"] }, env.dir);
  const src = await videoContent(env, "深度思考开到 max", "draft_ready", "源正文", { topicId: "topic-1-abc" });
  await setContent(env, src.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
  id = String((await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
  await setContent(env, id, { title: "写稿时的工作标题", body: BODY, status: "draft_ready" });
  genMock.mockReset();
  genMock.mockImplementation(async (_p, out) => {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, png(16, 9, "gen"));
    return { ok: true, stdout: "", stderr: "", provider: "codex", providerKind: "codex" };
  });
  await run({ op: "set_titles", titles: ["标题一", "标题二", "标题三"] });
  await run({ op: "choose_title", index: 2, founder_quote: "用第二个" });
  await run({ op: "generate_images" });
  await run({ op: "attach_web_image", index: 2, path: await put(path.join(env.outside, "shot.png"), png(1200, 800, "web")), url: "https://openai.com/pricing", credit: "图源：OpenAI 官网" });
  await run({ op: "set_cover", path: await put(path.join(env.outside, "cover.png"), png(2350, 1000, "m")) });
  await run({ op: "set_creation_source", creation_source: "内容由AI生成", founder_quote: "就选 AI 生成" });
});
afterEach(async () => { await env.cleanup(); });

describe("verifier findings: derived WeChat article", () => {
  it("P2 body edited after approval (founder in the editor) → article goes back to 等你拍板 so it can be re-approved", async () => {
    const d = (await draftItem())!;
    expect(await decideItem({ item_id: d.item_id, gen: d.gen, action: "approve_script", content_id: id }, env.dir)).toMatchObject({ ok: true });
    expect((await run({ op: "push_draft", dry_run: true })).ok).toBe(true);
    const body = (await getContent(id, env.dir))!.body;
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, action: "update", id, body: body.replace("官方页面长这样", "官方页面是这样的") })).toMatchObject({ ok: true });
    // the approval is now broken (push refuses, telling the agent to get it re-approved) …
    expect(await run({ op: "push_draft", dry_run: true })).toMatchObject({ ok: false, code: "article_not_approved" });
    // … so the founder must have something to approve. Today: status stays "approved" and no draft item exists (dead end).
    expect(await draftItem()).toBeDefined();
  });

  it("P2 chat approval brief shows the title that will actually be pushed (the founder-chosen one)", async () => {
    const r = await listForChat(env.dir, { content_id: id });
    const item = (r.items as Array<Record<string, unknown>>).find((i) => String(i.item_id).startsWith("draft:"))!;
    // pkg.chosenTitle = 标题二 is what push_draft sends as the WeChat title; content.title is only the working title
    expect(String(item.brief)).toContain("标题二");
  });

  it("P3 a web image attached to an unprefixed [IMAGE: …] slot is reported as kind web, not gen", async () => {
    // markers written without the "web:" / "gen:" prefix (as a writer naturally does) default to gen
    await setContent(env, id, { body: BODY.replace("[IMAGE: gen: 概念示意]", "[IMAGE: 概念示意]") });
    const r = await run({ op: "attach_web_image", index: 1, path: await put(path.join(env.outside, "shot1.png"), png(1200, 800, "w1")), url: "https://anthropic.com/news", credit: "图源：Anthropic 官网" });
    const first = (r.images as Array<Record<string, unknown>>).find((x) => x.index === 1)!;
    expect(first.source_url).toBe("https://anthropic.com/news");
    expect(first.kind).toBe("web");
  });
});
