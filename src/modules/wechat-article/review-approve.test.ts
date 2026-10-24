/**
 * Phase 2a 验收（二）：配图来源、标题与创作来源、篇幅、图文审阅页、批整包与批后失效、源过期挡发布。
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
import { derivedPublishRefusal } from "../lineage/publish-guard.js";
import { executeWechatArticle } from "../../tools/wechat-article.js";
import { readArticlePackage } from "./package.js";
import { contentRoot, projectFile } from "../../storage/content-project.js";

const genMock = vi.mocked(generateWechatImageAsset);
let env: Env;
let srcId: string;
let id: string;

const BODY = (chars: number) => `## 开头\n${"字".repeat(chars)}\n\n[IMAGE: gen: 概念示意]\n\n## 第二节\n官方页面长这样\n\n[IMAGE: web: OpenAI 定价页截图]`;
const run = (p: Record<string, unknown>) => executeWechatArticle({ _dataDir: env.dir, content_id: id, ...p });

beforeEach(async () => {
  env = await makeEnv();
  await initProfile(env.dir);
  await updateProfile({ platforms: ["douyin", "wechat_mp"] }, env.dir);
  const src = await videoContent(env, "深度思考开到 max", "draft_ready", "源正文", { topicId: "topic-1-abc" });
  srcId = src.id;
  await setContent(env, src.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
  const a = await executeWechatArticle({ _dataDir: env.dir, op: "derive", content_id: src.id });
  id = String(a.content_id);
  await setContent(env, id, { body: BODY(2600), status: "draft_ready" });
  genMock.mockReset();
  genMock.mockImplementation(async (_p, out) => {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, png(16, 9, "gen"));
    return { ok: true, stdout: "", stderr: "", provider: "codex", providerKind: "codex" };
  });
});
afterEach(async () => { await env.cleanup(); });

/** 把包补齐到可以批：标题、配图、封面、创作来源 */
async function complete() {
  expect(await run({ op: "set_titles", titles: JSON.stringify(["标题一", "标题二", "标题三"]) })).toMatchObject({ ok: true });
  expect(await run({ op: "choose_title", index: "2", founder_quote: "用第二个" })).toMatchObject({ ok: true, chosen_title: "标题二" });
  expect(await run({ op: "generate_images" })).toMatchObject({ ok: true, generated: 1 });
  const shot = await put(path.join(env.outside, "shot.png"), png(1200, 800, "web"));
  expect(await run({ op: "attach_web_image", index: 2, path: shot, url: "https://openai.com/pricing", credit: "图源：OpenAI 官网" })).toMatchObject({ ok: true });
  for (const [ratio, seed] of [["2.35:1", "w"], ["1:1", "s"]]) {
    expect(await run({ op: "set_cover", ratio, path: await put(path.join(env.outside, `cover-${seed}.png`), png(235, 100, seed)) })).toMatchObject({ ok: true });
  }
  expect(await run({ op: "set_creation_source", creation_source: "内容由AI生成", founder_quote: "就选 AI 生成" })).toMatchObject({ ok: true });
}

const draftItem = async () => (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === id)!;
const approve = async () => { const d = await draftItem(); return decideItem({ item_id: d.item_id, gen: d.gen, action: "approve_script", content_id: id }, env.dir); };

describe("配图来源", () => {
  it("gen：只走 Codex、提示词里真的要了 Image 2.5；记通道和请求的模型，codex 报不出模型 = unverified，从不记成已核实", async () => {
    const r = await run({ op: "generate_images" });
    expect(genMock.mock.calls[0][0]).toContain("目标模型为 Image 2.5");
    expect(genMock.mock.calls[0][2]).toMatchObject({ codexOnly: true });
    expect((r.images as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: "gen", status: "ready", provider: "codex", requested_model: "Image 2.5", model_status: "unverified" });
    // 普通稿件（非 codexOnly）走中转：请求的模型 = 设置里配的，状态 configured，不是已核实
    genMock.mockImplementationOnce(async (_p, out) => { await fs.writeFile(out, png(16, 9, "r")); return { ok: true, stdout: "", stderr: "", provider: "xiaojiu", providerKind: "relay", model: "gpt-image-2" }; });
    const { generateArticleImages } = await import("../publish/article-images.js");
    const plain = await generateArticleImages({ contentId: id, index: 0 }, env.dir);
    expect(plain.review.entries[0]).toMatchObject({ provider: "xiaojiu", requestedModel: "gpt-image-2", modelStatus: "configured" });
    expect(plain.review.entries[0].reportedModel).toBeUndefined();
  });

  it("gen 失败：那一张显示失败和原始原因，不拿别的图顶上；status 里列为不能批", async () => {
    genMock.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "codex: quota exceeded (429)" });
    const r = await run({ op: "generate_images" });
    expect(r).toMatchObject({ ok: false, failed: 1, errors: ["配图 1: codex: quota exceeded (429)"] });
    expect((await run({ op: "status" })).problems).toContain("配图 1 生成失败：codex: quota exceeded (429)");
  });

  it("web 图位不能生成；不带来源链接 / 署名登记不进去；没有链接的 web 图不能批", async () => {
    expect(await run({ op: "generate_images", index: 2 })).toMatchObject({ ok: false, code: "image_failed" });
    const shot = await put(path.join(env.outside, "shot.png"), png(1200, 800, "web"));
    expect(await run({ op: "attach_web_image", index: 2, path: shot, credit: "图源：官网" })).toMatchObject({ ok: false, code: "attach_failed", error: expect.stringMatching(/来源链接/) });
    expect(await run({ op: "attach_web_image", index: 2, path: shot, url: "ftp://x", credit: "图源" })).toMatchObject({ ok: false });
    expect(await run({ op: "attach_web_image", index: 2, path: shot, url: "https://openai.com" })).toMatchObject({ ok: false, error: expect.stringMatching(/署名/) });
    // 旧路径塞进来一张没有链接的图（比如手动上传到 web 图位）：审阅照样拦
    const { attachUploadedArticleImage } = await import("../publish/article-images.js");
    await attachUploadedArticleImage(id, 1, png(10, 10, "u"), env.dir, { origin: "web", sourceUrl: "https://a.com", credit: "x" });
    const file = projectFile(contentRoot(id, env.dir), "article-images.json");
    const review = JSON.parse(await fs.readFile(file, "utf8"));
    delete review.entries[1].sourceUrl;
    await fs.writeFile(file, JSON.stringify(review));
    expect((await run({ op: "status" })).problems).toContain("配图 2 是 web 图但没有来源链接，不能过审");
  });
});

describe("标题、创作来源、篇幅", () => {
  it("标题候选 3-5 个；只能选候选里的、要原话", async () => {
    expect(await run({ op: "set_titles", titles: ["a", "b"] })).toMatchObject({ ok: false });
    await run({ op: "set_titles", titles: ["a", "b", "c"] });
    expect(await run({ op: "choose_title", title: "d", founder_quote: "d" })).toMatchObject({ ok: false, code: "title_not_in_options" });
    expect(await run({ op: "choose_title", title: "a" })).toMatchObject({ ok: false, code: "founder_words_required" });
  });

  it("创作来源只收公众号原选项、要原话；有生成图时不许「无需声明」；建议值是「内容由AI生成」", async () => {
    await run({ op: "generate_images" });
    expect((await run({ op: "status" })).suggested_creation_source).toBe("内容由AI生成");
    expect(await run({ op: "set_creation_source", creation_source: "AI 生成", founder_quote: "x" })).toMatchObject({ ok: false, code: "invalid_creation_source" });
    expect(await run({ op: "set_creation_source", creation_source: "内容由AI生成" })).toMatchObject({ ok: false, code: "founder_words_required" });
    expect(await run({ op: "set_creation_source", creation_source: "无需声明", founder_quote: "不用声明" })).toMatchObject({ ok: false, code: "ai_images_need_declaration" });
  });

  it("篇幅不在 2500-4000 → 标出来；创始人原话放行后不再拦；正文一改放行作废", async () => {
    await setContent(env, id, { body: BODY(1200) });
    expect((await run({ op: "status" })).problems).toEqual(expect.arrayContaining([expect.stringMatching(/少于 2500/)]));
    expect(await run({ op: "override_length" })).toMatchObject({ ok: false, code: "founder_words_required" });
    expect(await run({ op: "override_length", founder_quote: "短一点没关系，就这样" })).toMatchObject({ ok: true });
    expect(((await run({ op: "status" })).problems as string[]).some((p) => /2500/.test(p))).toBe(false);
    await setContent(env, id, { body: BODY(1300) });
    expect(((await run({ op: "status" })).problems as string[]).some((p) => /少于 2500/.test(p))).toBe(true);
    await setContent(env, id, { body: BODY(3000) });
    expect(await run({ op: "override_length", founder_quote: "行" })).toMatchObject({ ok: false, code: "length_in_range" });
  });
});

describe("图文审阅 = 批整包", () => {
  it("没补齐就批 → 拒并逐条列出缺什么", async () => {
    const r = await approve();
    expect(r).toMatchObject({ ok: false, code: "article_not_ready" });
    expect(String(r.error)).toMatch(/标题候选.*\n.*创作来源/s);
  });

  it("认稿那件带图文审阅页（网页）和还差什么；审阅页里有图、署名链接、封面、创作来源、model unverified", async () => {
    await complete();
    const r = await listForChat(env.dir, { content_id: id });
    const item = (r.items as Array<Record<string, unknown>>).find((i) => String(i.item_id).startsWith(`draft:`))!;
    expect(String(item.brief)).toMatch(/图文审阅页/);
    expect(String(item.brief)).toMatch(/都齐了/);
    const page = (item.preview as { pages: Array<{ path: string; opened: boolean }> }).pages[0];
    expect(page.opened).toBe(false);
    const html = await fs.readFile(page.path, "utf8");
    for (const s of ["标题二（已选）", "https://openai.com/pricing", "图源：OpenAI 官网", "内容由AI生成", "model unverified", "2.35:1", "1:1", "<img src=\"file://"]) expect(html).toContain(s);
  });

  it("补齐后批 → 记整包批准；但 2b 接上之前所有发布出口都拒（不按旧标题旧封面发）", async () => {
    await complete();
    expect(await approve()).toMatchObject({ ok: true });
    expect((await readArticlePackage(id, env.dir)).approval?.artifact).toBe("公众号图文发布包");
    expect((await getContent(id, env.dir))!.status).toBe("approved");
    expect(await derivedPublishRefusal((await getContent(id, env.dir))!, env.dir)).toMatchObject({ code: "derived_article_publish_pending" });
    const { executePublish } = await import("../../tools/publish.js");
    for (const action of ["clipboard", "ego_lite_prepare", "wechat_mp_draft"]) {
      const r = await executePublish({ action, content_id: id, _dataDir: env.dir }) as Record<string, unknown>;
      expect(r, action).toMatchObject({ ok: false, code: "derived_article_publish_pending" });
      expect(String(r.error)).toMatch(/2b/);
    }
    const { executePrePublish } = await import("../../tools/pre-publish.js");
    expect(await executePrePublish({ action: "check", content_id: id, _dataDir: env.dir })).toMatchObject({ ok: false });
  });

  it("出示之后包被改（绕过代次的竞态）：批准带着出示时的包指纹，对不上就拒", async () => {
    await complete();
    const shown = String((await draftItem()).detail.package_hash);
    const { articleApproveGate } = await import("./approve.js");
    expect(await articleApproveGate(id, env.dir, shown)).toMatchObject({ ok: true });
    await run({ op: "set_titles", titles: ["新一", "新二", "新三"] });
    expect(await articleApproveGate(id, env.dir, shown)).toMatchObject({ ok: false, code: "stale" });
    expect(await articleApproveGate(id, env.dir, undefined)).toMatchObject({ ok: false, code: "stale" });
  });

  it("包改动和认稿排同一把锁：先排的改动做完，认稿才核包", async () => {
    const { withArticleLock } = await import("./package.js");
    const order: string[] = [];
    let release!: () => void;
    const first = withArticleLock(id, () => new Promise<void>((r) => { release = () => { order.push("改包"); r(); }; }));
    const second = withArticleLock(id, async () => { order.push("认稿"); });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["改包", "认稿"]);
  });

  it("出图前就选了「无需声明」：之后有了生成图，status 和批准都拦", async () => {
    await run({ op: "set_creation_source", creation_source: "无需声明", founder_quote: "不用声明" });
    await complete();
    const pkg = await readArticlePackage(id, env.dir);
    const { writeArticlePackage } = await import("./package.js");
    await writeArticlePackage(id, { ...pkg, creationSource: { value: "无需声明", founderWords: "不用声明", at: "x" } }, env.dir);
    expect((await run({ op: "status" })).problems).toEqual(expect.arrayContaining([expect.stringMatching(/不能是「无需声明」/)]));
    expect(await approve()).toMatchObject({ ok: false, code: "article_not_ready" });
  });

  it("封面文件被删 → 不能批，原因写明", async () => {
    await complete();
    await fs.rm((await readArticlePackage(id, env.dir)).covers[1].path);
    expect((await run({ op: "status" })).problems).toEqual(expect.arrayContaining([expect.stringMatching(/1:1 封面文件不见了/)]));
    expect(await approve()).toMatchObject({ ok: false, code: "article_not_ready" });
  });

  it("批之后封面文件变了 → 批准失效，status 写明是整包变了", async () => {
    await complete();
    await approve();
    const content = async () => (await getContent(id, env.dir))!;
    const pkg = await readArticlePackage(id, env.dir);
    await fs.writeFile(pkg.covers[0].path, png(235, 100, "changed"));
    void content;
    expect((await run({ op: "status" })).approval).toMatch(/批准已失效：公众号图文发布包在批准之后变了/);
  });

  it("列出之后包变了（换了创作来源）→ 用旧代次批会回 stale，不批旧的", async () => {
    await complete();
    const d = await draftItem();
    await run({ op: "set_creation_source", creation_source: "个人观点，仅供参考", founder_quote: "改成个人观点" });
    expect(await decideItem({ item_id: d.item_id, gen: d.gen, action: "approve_script", content_id: id }, env.dir)).toMatchObject({ ok: false, code: "stale" });
  });

  it("批之后源视频换了一版成片 → 发布核对按过期拦（Phase 1 的发布出口核对覆盖这条）", async () => {
    await complete();
    await approve();
    await setContent(env, srcId, { videoDone: { renderedRevision: 2, at: new Date().toISOString() } });
    expect(await derivedPublishRefusal((await getContent(id, env.dir))!, env.dir)).toMatchObject({ code: "derived_stale" });
    const { executePublish } = await import("../../tools/publish.js");
    expect(await executePublish({ action: "wechat_mp_draft", content_id: id, _dataDir: env.dir })).toMatchObject({ ok: false, code: "derived_stale" });
  });
});
