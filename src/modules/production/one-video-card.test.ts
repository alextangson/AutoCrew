/**
 * 一条视频一张卡（spec 2026-10-12）后端契约：按平台的发布包、平台标签、只有回执没认稿、全部被驳回、按平台动作带平台和轮次。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyProductionDoc, type Fact, type ProductionDoc } from "../../storage/production-types.js";
import type { PublishRecord } from "../../storage/publish-record.js";
import type { Content, VideoKit } from "../../storage/local-store.js";
import { getContent } from "../../storage/local-store.js";
import { primaryVideoKit, putVideoKit, videoKitFor, videoKitsOf } from "../../storage/video-kits.js";
import { publishSurface, targetPlatform } from "../../tools/pre-publish-kit.js";
import { executePublish } from "../../tools/publish.js";
import { writeEnabledVersion } from "../../storage/production-store.js";
import { BODY, decision, doc, fact, fullFacts } from "./derive-fixtures.js";
import { explain, NO_SCRIPT_APPROVAL } from "./explain.js";
import { ALL_REJECTED } from "./derive.js";
import { publishTargets } from "./targets.js";
import { founderDecision } from "./decisions.js";
import { registeredVideo } from "../publish/review-gate/testkit.js";
import { makeEnv, setContent, videoContent, type Env } from "./testkit.js";
import { sameVideoRefusal } from "../../tools/variant-guard.js";
import { executeContentSave } from "../../tools/content-save.js";

const kit = (platform: string, caption = `${platform} 的简介`): VideoKit => ({ platform, postTitle: `${platform} 标题`, caption, storyboard: [], coverText: "封面", coverPrompt: "", generatedAt: "2026-10-12T00:00:00.000Z" });
const NOW = new Date().toISOString();
const pub = (platform: string, pub_state: Fact["pub_state"], extra: Partial<Fact> = {}): Fact =>
  fact("publish", undefined, { platform, pub_state, obs_source: "plan", verified: true, seen_at: NOW, evidence: "发布计划里的记录", ...extra });
const video = (status: Content["status"] = "publish_ready") => ({ id: "content-x", status, platform: "douyin", body: BODY });
const planOf = (...ps: Array<[string, string]>): PublishRecord => ({ kind: "ok", platforms: ps.map(([platform, state]) => ({ platform, state: state as never, submitted: state !== "not_submitted", raw: null, review: null, time: null, reason: null, url: null, campaigns: [], manual: null })) });

describe("videoKits 按平台存", () => {
  it("旧单包读时迁移成 {平台: 包}；写别的平台保留旧包并删掉旧字段", () => {
    const legacy = { platform: "douyin", videoKit: kit("douyin") };
    expect(Object.keys(videoKitsOf(legacy))).toEqual(["douyin"]);
    const patch = putVideoKit(legacy, kit("xiaohongshu"));
    expect(Object.keys(patch.videoKits!).sort()).toEqual(["douyin", "xiaohongshu"]);
    expect("videoKit" in patch && patch.videoKit === undefined).toBe(true);
  });
  it("按平台取包，不拿别的平台的包顶；主平台优先", () => {
    const c = { platform: "douyin", videoKits: { xiaohongshu: kit("xiaohongshu") } };
    expect(videoKitFor(c, "douyin")).toBeUndefined();
    expect(primaryVideoKit(c)?.platform).toBe("xiaohongshu");
    expect(publishSurface({ ...c, title: "稿", body: "正文", hashtags: [] } as unknown as Content, "xiaohongshu")).toMatchObject({ fromKit: true, title: "xiaohongshu 标题" });
  });
  it("检查平台：视频稿可以换成别的视频平台；文字稿只认自己", () => {
    expect(targetPlatform({ platform: "douyin" } as Content, "bilibili")).toBe("bilibili");
    expect(targetPlatform({ platform: "douyin" } as Content, undefined)).toBe("douyin");
    expect(targetPlatform({ platform: "wechat_mp" } as Content, "douyin")).toMatchObject({ code: "platform_mismatch" });
  });
});

describe("平台标签（吸收 4 / 12 / 13）", () => {
  const d = (...facts: Fact[]): ProductionDoc => doc([...fullFacts(), ...facts], []);
  it("平台 = 计划 ∪ 回执；未发的给「准备发布 / 标已发」，已投出的只给纠正", () => {
    const t = publishTargets(video(), d(pub("douyin", "public")), planOf(["douyin", "public"], ["bilibili", "not_submitted"]), true);
    expect(t.map((x) => [x.platform, x.state])).toEqual([["douyin", "已公开"], ["bilibili", "未发"]]);
    expect(t[1].actions).toEqual(["prepare_publish", "i_published"]);
    expect(t[0].actions).toEqual(["correct_publish"]);
  });
  it("计划删了平台，已有回执照样显示；被驳回给重新提交；待核给确认 / 纠正；读不懂的不显示成未发", () => {
    const t = publishTargets(video(), d(pub("wechat_video", "rejected", { reason: "封面违规" }), pub("bilibili", "public", { obs_source: "claim", verified: false })), planOf(["xiaohongshu", "unknown"]), true);
    const by = Object.fromEntries(t.map((x) => [x.platform, x]));
    expect(by.wechat_video).toMatchObject({ state: "被驳回", reason: "封面违规", actions: ["resubmit", "correct_publish"] });
    expect(by.bilibili).toMatchObject({ state: "待核", actions: ["confirm_receipt", "correct_publish"] });
    expect(by.xiaohongshu.state).toBe("读不到");
  });
  it("没计划没回执 = 稿件平台未发；文字稿没有平台标签；计划读不到不说成未发", () => {
    expect(publishTargets(video(), d(), null, true)).toMatchObject([{ platform: "douyin", state: "未发" }]);
    expect(publishTargets({ platform: "wechat_mp" }, null, null, true)).toEqual([]);
    expect(publishTargets(video(), d(), { kind: "unreadable", reason: "坏了", platforms: [] }, true)[0].state).toBe("读不到");
  });
  it("未启用本体：按计划给状态，不给按平台动作（走旧流转）", () => {
    expect(publishTargets(video(), null, planOf(["douyin", "scheduled"]), false)).toMatchObject([{ state: "已定时", actions: [] }]);
  });
});

describe("阶段由事实推进（吸收 5 / 12）", () => {
  const noScript = (facts: Fact[]): ProductionDoc => ({ ...emptyProductionDoc(), facts });
  it("有已投出回执、没认稿 → 已发布 + 没走认稿；不补认稿", () => {
    const dd = noScript([pub("douyin", "scheduled")]);
    const e = explain({ content: video("draft_ready"), doc: dd, enabled: true, publish: { verified: false } });
    expect(e).toMatchObject({ column: "已发布", no_script_approval: true });
    expect(e.badges).toContain(NO_SCRIPT_APPROVAL);
    expect(dd.decisions).toHaveLength(0);
  });
  it("topic_saved：有已投出回执才上看板，否则不上", () => {
    expect(explain({ content: video("topic_saved"), doc: noScript([pub("douyin", "public")]), enabled: true, publish: { verified: false } }).column).toBe("已发布");
    expect(explain({ content: video("topic_saved"), doc: noScript([]), enabled: true, publish: { verified: false } }).column).toBeNull();
  });
  it("只有待核回执不算已发布", () => {
    expect(explain({ content: video("draft_ready"), doc: noScript([pub("douyin", "public", { obs_source: "claim", verified: false })]), enabled: true, publish: { verified: false } }).column).toBe("写稿中");
  });
  it("全部被驳回 → 回待发布，红字带原因；一个平台投出就仍是已发布", () => {
    const all = explain({ content: video(), doc: doc([...fullFacts(), pub("douyin", "rejected", { reason: "画面违规" })], []), enabled: true, publish: { verified: false } });
    expect(all).toMatchObject({ column: "待发布", rule: "D1R" });
    expect(all.alerts[0]).toContain(ALL_REJECTED);
    expect(all.alerts[0]).toContain("画面违规");
    const some = explain({ content: video(), doc: doc([...fullFacts(), pub("douyin", "rejected"), pub("bilibili", "reviewing")], []), enabled: true, publish: { verified: false } });
    expect(some.column).toBe("已发布");
  });
  it("驳回 + 待核：不判全部被驳回", () => {
    const e = explain({ content: video(), doc: doc([...fullFacts(), pub("douyin", "rejected"), pub("bilibili", "public", { obs_source: "claim", verified: false })], [decision("cut_approval")]), enabled: true, publish: { verified: false } });
    expect(e.rule).not.toBe("D1R");
  });
});

describe("按平台动作带平台和轮次（吸收 3）", () => {
  let env: Env;
  beforeEach(async () => { env = await makeEnv({ enabled: false }); await writeEnabledVersion(env.dir); });
  afterEach(async () => { await env.cleanup(); });

  it("「我发了」不带平台被拒（不拿稿件平台顶）；带旧轮次被拒；带对的平台和轮次记上", async () => {
    const r = await registeredVideo(env);
    expect(await founderDecision(r.id, "i_published", {}, env.dir)).toMatchObject({ ok: false, code: "platform_required" });
    expect(await founderDecision(r.id, "i_published", { platform: "bilibili", round: 9 }, env.dir)).toMatchObject({ ok: false, code: "stale" });
    expect(await founderDecision(r.id, "i_published", { platform: "bilibili", round: 1 }, env.dir)).toMatchObject({ ok: true, stage: "已发布" });
    expect(await founderDecision(r.id, "correct_publish", { platform: "bilibili", round: 9 }, env.dir)).toMatchObject({ ok: false, code: "stale" });
  });
  it("confirm_published 不带平台被拒", async () => {
    const r = await registeredVideo(env);
    expect(await executePublish({ _dataDir: env.dir, action: "confirm_published", content_id: r.id, _host: "codex" })).toMatchObject({ ok: false, code: "platform_required" });
    expect((await getContent(r.id, env.dir))!.status).not.toBe("published");
  });
});

describe("AI 想新建平台稿（边界 10 / 吸收 7）", () => {
  let env: Env;
  beforeEach(async () => { env = await makeEnv({ enabled: false }); await writeEnabledVersion(env.dir); });
  afterEach(async () => { await env.cleanup(); });

  it("同选题已有带制作记录的视频稿：视频平台拒、指去发布计划；distinct_video 放行；文字平台照常；没制作的不拦", async () => {
    const r = await registeredVideo(env);
    await setContent(env, r.id, { topicId: "topic-1" });
    expect(await sameVideoRefusal("topic-1", "bilibili", undefined, env.dir)).toMatchObject({ ok: false, code: "same_video_variant", content_id: r.id });
    expect(await sameVideoRefusal("topic-1", "bilibili", true, env.dir)).toBeNull();
    expect(await sameVideoRefusal("topic-1", "wechat_mp", undefined, env.dir)).toBeNull();
    const fresh = await videoContent(env, "还没开拍的稿");
    await setContent(env, fresh.id, { topicId: "topic-2" });
    expect(await sameVideoRefusal("topic-2", "bilibili", undefined, env.dir)).toBeNull();
  });
  it("模型调 create_variant 走到这道闸，不建稿", async () => {
    const r = await registeredVideo(env);
    await setContent(env, r.id, { topicId: "topic-1" });
    const res = await executeContentSave({ action: "create_variant", topicId: "topic-1", platform: "xiaohongshu", _host: "codex", _dataDir: env.dir });
    expect(res).toMatchObject({ ok: false, code: "same_video_variant" });
  });
});
