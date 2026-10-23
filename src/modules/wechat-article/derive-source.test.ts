/**
 * Phase 2a 验收（一）：从审过的视频派生公众号文章、底稿从哪来、写作包怎么改写。
 * 边界：没勾公众号 / 成片没审过 / 源在回收站都拒；派生两次是同一篇；没有成片字幕时底稿退回定稿正文并写明原因。
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderDecision } from "../production/decisions.js";
import { founderApprove, makeEnv, png, put, record, setContent, SRT, videoContent, waiveSliverCheck, type Env } from "../production/testkit.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { articleArgs, executeWechatArticle } from "../../tools/wechat-article.js";
import { derivedArticleRequest, stripSourceBlock } from "./writer-request.js";
import { readArticlePackage } from "./package.js";
import { SOURCE_BLOCK_HEAD } from "./source.js";

let env: Env;
afterEach(async () => { await env.cleanup(); });

async function pick(platforms: string[]) { await initProfile(env.dir); await updateProfile({ platforms }, env.dir); }
const run = (p: Record<string, unknown>) => executeWechatArticle({ _dataDir: env.dir, ...p });

/** 旧流程源视频：成片身份 = videoDone */
async function legacySource(platforms = ["douyin", "wechat_mp"]) {
  env = await makeEnv();
  await pick(platforms);
  const c = await videoContent(env, "深度思考开到 max", "draft_ready", "源视频的定稿正文。", { topicId: "topic-1-abc" });
  return setContent(env, c.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
}

/** 本体启用、成片已批并登记（带字幕）的源视频 */
async function registeredSource(opts: { covers?: boolean } = {}) {
  env = await makeEnv({ enabled: true });
  await pick(["douyin", "wechat_mp"]);
  const c = await videoContent(env, "AI 又忘了怎么办");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
  const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "AI又忘了怎么办.mp4"), "cut-v1"), request_id: "c", review: true });
  await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "a.srt"), SRT), for_cut: cut.fact_id, request_id: "s" });
  const c34 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c34.png"), png(900, 1200)), request_id: "p1" });
  const c43 = await record(env, { content_id: c.id, kind: "cover", path: await put(path.join(env.chatcut, "c43.png"), png(1200, 900)), version: 1, request_id: "p2" });
  const doc = (await readProductionDoc(c.id, env.dir))!;
  const sha = (id: unknown) => doc.facts.find((f) => f.id === id)!.sha256!;
  await waiveSliverCheck(env, c.id, sha(cut.fact_id));
  expect(await founderDecision(c.id, "approve_cut", { fact_id: cut.fact_id, sha256: sha(cut.fact_id) }, env.dir)).toMatchObject({ ok: true });
  if (opts.covers === false) return c;
  expect(await founderDecision(c.id, "pick_cover", { cover_3x4_fact_id: c34.fact_id, cover_3x4_sha: sha(c34.fact_id), cover_4x3_fact_id: c43.fact_id, cover_4x3_sha: sha(c43.fact_id) }, env.dir)).toMatchObject({ ok: true });
  return c;
}

describe("derive：从审过的视频派生公众号文章", () => {
  it("没勾公众号 → 拒，原因是中文", async () => {
    const src = await legacySource(["douyin"]);
    const r = await run({ action: "wechat_article", op: "derive", content_id: src.id });
    expect(r).toMatchObject({ ok: false, code: "line_not_enabled" });
    expect(String(r.error)).toMatch(/公众号/);
  });

  it("成片没审过 → 拒；源在回收站 → 拒", async () => {
    env = await makeEnv();
    await pick(["douyin", "wechat_mp"]);
    const raw = await videoContent(env, "还没剪完");
    expect(await run({ op: "derive", content_id: raw.id })).toMatchObject({ ok: false, code: "no_approved_cut" });
    const gone = await videoContent(env, "删掉的");
    await setContent(env, gone.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() }, deletedAt: new Date().toISOString() });
    expect(await run({ op: "derive", content_id: gone.id })).toMatchObject({ ok: false, code: "source_deleted" });
  });

  it("派生两次是同一篇；跟源视频同一个选题；回下一步领写作包（带 content_id）", async () => {
    const src = await legacySource();
    const a = await run({ op: "derive", content_id: src.id });
    const b = await run({ article: JSON.stringify({ op: "derive", content_id: src.id }) });
    expect(a).toMatchObject({ ok: true, created: true, platform: "wechat_mp" });
    expect(b).toMatchObject({ ok: true, created: false, content_id: a.content_id });
    expect(a.next_action).toEqual({ tool: "autocrew_writer", params: { action: "pack", topic_id: "topic-1-abc", platform: "wechat_mp", content_id: a.content_id } });
  });

  it("不是派生公众号文章的稿：其他 op 一律拒", async () => {
    const src = await legacySource();
    expect(await run({ op: "status", content_id: src.id })).toMatchObject({ ok: false, code: "not_derived_article" });
    expect(await run({ op: "nope", content_id: src.id })).toMatchObject({ ok: false, code: "invalid_params" });
  });
});

describe("底稿：成片字幕优先，没有就退回定稿正文并写明", () => {
  it("旧流程源视频没有登记字幕 → 底稿是定稿正文，说明里写了原因", async () => {
    const src = await legacySource();
    const a = await run({ op: "derive", content_id: src.id });
    const s = await run({ op: "source", content_id: a.content_id });
    expect(s).toMatchObject({ ok: true, kind: "script" });
    expect(String(s.note)).toMatch(/不是成片转写.*旧流程/);
    expect(String(s.head)).toContain("源视频的定稿正文");
  });

  it("本体源视频成片已登记字幕 → 底稿是字幕全文", async () => {
    const src = await registeredSource();
    const a = await run({ op: "derive", content_id: src.id });
    expect(a).toMatchObject({ ok: true });
    const s = await run({ op: "source", content_id: a.content_id });
    expect(s).toMatchObject({ ok: true, kind: "srt", head: "你好" });
  });
});

describe("封面还在做（和文章并行）时底稿照样是成片字幕", () => {
  it("只批了成片、封面没批：kind = srt，不退回定稿正文", async () => {
    const src = await registeredSource({ covers: false });
    const a = await run({ op: "derive", content_id: src.id });
    expect(a).toMatchObject({ ok: true });
    expect(await run({ op: "source", content_id: a.content_id })).toMatchObject({ ok: true, kind: "srt", head: "你好" });
  });
});

describe("写作包改写：固定长文包，底稿接在写作要求后，重领不叠两份", () => {
  it("packId = wechat_video_article；底稿说明记进发布包；strip 后再接是同一份", async () => {
    const src = await legacySource();
    const a = await run({ op: "derive", content_id: src.id });
    const { getContent } = await import("../../storage/local-store.js");
    const article = (await getContent(String(a.content_id), env.dir))!;
    const req = { topic: "t", platform: "wechat_mp" as const, requirements: "写给不写代码的人" };
    const first = await derivedArticleRequest(article, req, env.dir);
    if (!first?.ok) throw new Error("应当改写");
    expect(first.req.packId).toBe("wechat_video_article");
    expect(first.req.requirements).toContain(SOURCE_BLOCK_HEAD);
    expect(stripSourceBlock(first.req.requirements)).toBe("写给不写代码的人");
    const again = await derivedArticleRequest(article, first.req, env.dir);
    expect(again?.ok && again.req.requirements).toBe(first.req.requirements);
    expect((await readArticlePackage(article.id, env.dir)).sourceNote).toMatch(/定稿正文/);
    expect(await derivedArticleRequest(src, req, env.dir)).toBeNull();
  });
});

describe("参数归一（AGENTS.md）", () => {
  it("article 是 JSON 字符串、带没转义的引号也能解析；解析不了明确报错", () => {
    expect(articleArgs({ article: '{"op":"set_titles","titles":["他说"别急"","b","c"]}' })).toMatchObject({ op: "set_titles" });
    expect(typeof articleArgs({ article: "{op" })).toBe("string");
    expect(articleArgs({ op: "status" })).toMatchObject({ op: "status" });
  });
});
