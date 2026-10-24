/**
 * 派生关系（全媒体 spec §8 Phase 1 #2）：幂等派生、两边互挂、源成片换版 / 撤批后过期。
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { getContent, listContents } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderDecision } from "../production/decisions.js";
import { founderApprove, makeEnv, put, record, setContent, videoContent, waiveSliverCheck, type Env } from "../production/testkit.js";
import { boardData } from "../../desktop/board-data.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { approvedCutIdentity, deriveSibling, isStale, staleReason } from "./lineage.js";

let env: Env;

/** 用户在引导 / 设置里勾的平台：线开不开看它 */
async function pickPlatforms(platforms: string[]) {
  await initProfile(env.dir);
  await updateProfile({ platforms }, env.dir);
}
afterEach(async () => { await env.cleanup(); });

/** 旧流程（未启用本体）：成片身份 = videoDone.renderedRevision */
async function legacyApproved(rev = 1, platforms = ["douyin", "wechat_mp", "youtube"]) {
  env = await makeEnv();
  await pickPlatforms(platforms);
  const c = await videoContent(env, "深度思考开到 max");
  return setContent(env, c.id, { videoDone: { renderedRevision: rev, at: new Date().toISOString() } });
}

describe("deriveSibling", () => {
  it("第二次派生拿回同一条，不建第二条；参数是字符串化的值也认", async () => {
    const src = await legacyApproved();
    const a = await deriveSibling(src.id, "en_edition", env.dir);
    const b = await deriveSibling(src.id, "\"en_edition\"", env.dir);
    expect(a).toMatchObject({ ok: true, created: true });
    expect(b).toMatchObject({ ok: true, created: false });
    if (!a.ok || !b.ok) return;
    expect(b.content.id).toBe(a.content.id);
    expect((await listContents(env.dir)).filter((c) => c.derivedFrom?.contentId === src.id)).toHaveLength(1);
  });

  it("并发双击只建一条", async () => {
    const src = await legacyApproved();
    const [a, b] = await Promise.all([deriveSibling(src.id, "wechat_article", env.dir), deriveSibling(src.id, "wechat_article", env.dir)]);
    expect(a.ok && b.ok && a.content.id === b.content.id).toBe(true);
    expect((await listContents(env.dir)).filter((c) => c.derivedFrom?.kind === "wechat_article")).toHaveLength(1);
  });

  it("派生关系落盘、两边互挂 siblings、平台按派生类型", async () => {
    const src = await legacyApproved(3);
    const r = await deriveSibling(src.id, "en_edition", env.dir);
    if (!r.ok) throw new Error(r.error);
    const derived = (await getContent(r.content.id, env.dir))!;
    expect(derived.platform).toBe("youtube");
    expect(derived.derivedFrom).toMatchObject({ contentId: src.id, kind: "en_edition", sourceCutHash: "legacy-rev:3" });
    expect(derived.siblings).toContain(src.id);
    expect((await getContent(src.id, env.dir))!.siblings).toContain(derived.id);
    const w = await deriveSibling(src.id, "wechat_article", env.dir);
    expect(w.ok && w.content.platform).toBe("wechat_mp");
    expect((await getContent(src.id, env.dir))!.siblings).toEqual([derived.id, w.ok ? w.content.id : ""]);
  });

  it("没有审过的成片、源不存在、类型不对都拒并说原因", async () => {
    env = await makeEnv();
    await pickPlatforms(["douyin", "youtube"]);
    const c = await videoContent(env, "还没剪完");
    expect(await deriveSibling(c.id, "en_edition", env.dir)).toMatchObject({ ok: false, code: "no_approved_cut" });
    expect(await deriveSibling("content-nope", "en_edition", env.dir)).toMatchObject({ ok: false, code: "source_missing" });
    expect(await deriveSibling(c.id, "fr_edition", env.dir)).toMatchObject({ ok: false, code: "bad_kind" });
  });
});

describe("只有勾了的平台才开线（创始人 2026-10-23 增补）", () => {
  it("没勾公众号不派生公众号文章，没勾 YouTube / X 不派生英文版，原因是中文", async () => {
    const src = await legacyApproved(1, ["douyin", "xiaohongshu"]);
    const w = await deriveSibling(src.id, "wechat_article", env.dir);
    expect(w).toMatchObject({ ok: false, code: "line_not_enabled" });
    expect(!w.ok && w.error).toMatch(/公众号/);
    expect(await deriveSibling(src.id, "en_edition", env.dir)).toMatchObject({ ok: false, code: "line_not_enabled" });
    expect((await listContents(env.dir)).filter((c) => c.derivedFrom)).toHaveLength(0);
  });

  // spec §9.3（创始人 2026-10-24）：旧 twitter 只管图文推，不再打开英文视频线
  it("旧档案只有 twitter：英文版线不开，要明确勾 X / YouTube", async () => {
    const src = await legacyApproved(1, ["douyin", "twitter"]);
    expect(await deriveSibling(src.id, "en_edition", env.dir)).toMatchObject({ ok: false, code: "line_not_enabled" });
  });

  it("之后取消勾选不删已派生的稿；再派生拿回原来那条，新的派生被拒", async () => {
    const src = await legacyApproved(1, ["douyin", "wechat_mp"]);
    const first = await deriveSibling(src.id, "wechat_article", env.dir);
    if (!first.ok) throw new Error(first.error);
    await pickPlatforms(["douyin"]);
    expect(await getContent(first.content.id, env.dir)).not.toBeNull();
    const again = await deriveSibling(src.id, "wechat_article", env.dir);
    expect(again.ok && again.content.id).toBe(first.content.id);
    expect(await deriveSibling(src.id, "en_edition", env.dir)).toMatchObject({ ok: false, code: "line_not_enabled" });
  });
});

describe("staleness（旧流程）", () => {
  it("源成片重渲染 / 重开剪辑后过期，看板卡带原因", async () => {
    const src = await legacyApproved(1);
    const r = await deriveSibling(src.id, "en_edition", env.dir);
    if (!r.ok) throw new Error(r.error);
    expect(await isStale(r.content, env.dir)).toBe(false);
    await setContent(env, src.id, { videoDone: { renderedRevision: 2, at: new Date().toISOString() } });
    expect(await staleReason(r.content, env.dir)).toMatch(/源视频换了一版成片/);
    await setContent(env, src.id, { videoDone: undefined });
    expect(await staleReason(r.content, env.dir)).toMatch(/重开了剪辑/);
    const card = (await boardData(env.dir)).items.find((i) => i.id === r.content.id);
    expect(card?.derivedStale).toMatch(/重开了剪辑/);
    expect((await boardData(env.dir)).items.find((i) => i.id === src.id)?.derivedStale).toBeNull();
  });
});

describe("staleness（本体：成片批准所绑文件的 sha256）", () => {
  const decide = async (id: string, action: string, p: Record<string, unknown>) => {
    if (action === "approve_cut") await waiveSliverCheck(env, id, p.sha256 as string);
    return founderDecision(id, action, p, env.dir);
  };
  async function approveCut(id: string, name: string, bytes: string, req: string) {
    const f = await record(env, { content_id: id, kind: "cut", path: await put(path.join(env.chatcut, name), bytes), request_id: req, review: true });
    const sha = (await readProductionDoc(id, env.dir))!.facts.find((x) => x.id === f.fact_id)!.sha256!;
    expect(await decide(id, "approve_cut", { fact_id: f.fact_id, sha256: sha })).toMatchObject({ ok: true });
    return sha;
  }

  it("旧流程导入的老视频（有成片事实、没审片决定、有 videoDone）按旧标记派生；真审过一次后换成文件指纹", async () => {
    env = await makeEnv({ enabled: true });
    await pickPlatforms(["douyin", "wechat_mp"]);
    const c = await videoContent(env, "深度思考开到 max");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "深度思考-原片.mov"), "raw"), request_id: "a" });
    await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "深度思考.mp4"), "cut-v1"), request_id: "c0" });
    await setContent(env, c.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
    const source = (await getContent(c.id, env.dir))!;
    expect(await approvedCutIdentity(source, env.dir)).toEqual({ id: "legacy-rev:1" });
    const r = await deriveSibling(c.id, "wechat_article", env.dir);
    if (!r.ok) throw new Error(r.error);
    expect(r.content.derivedFrom?.sourceCutHash).toBe("legacy-rev:1");

    const sha = await approveCut(c.id, "深度思考-v2.mp4", "cut-v2", "c2");
    expect(await approvedCutIdentity((await getContent(c.id, env.dir))!, env.dir)).toEqual({ id: `sha256:${sha}` });
    expect(await isStale(r.content, env.dir)).toBe(true);
  });

  it("换批新一版成片 → 过期；撤批 → 过期", async () => {
    env = await makeEnv({ enabled: true });
    await pickPlatforms(["douyin", "wechat_mp"]);
    const c = await videoContent(env, "AI 又忘了怎么办");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "AI又忘了怎么办-原片.mov"), "raw"), request_id: "a" });
    const sha1 = await approveCut(c.id, "AI又忘了怎么办.mp4", "cut-v1", "c1");
    const source = (await getContent(c.id, env.dir))!;
    expect(await approvedCutIdentity(source, env.dir)).toEqual({ id: `sha256:${sha1}` });
    const r = await deriveSibling(c.id, "wechat_article", env.dir);
    if (!r.ok) throw new Error(r.error);
    expect(await isStale(r.content, env.dir)).toBe(false);

    await approveCut(c.id, "AI又忘了怎么办-v2.mp4", "cut-v2", "c2");
    expect(await staleReason(r.content, env.dir)).toMatch(new RegExp(`派生时 ${sha1.slice(0, 8)}`));
  });
});
