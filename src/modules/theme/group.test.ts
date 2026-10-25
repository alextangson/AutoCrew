/**
 * 主题分组 + 去向回执（管线重规划 §8-1/2/3）：纯函数，验收清单里的边界逐条一个用例。
 */
import { describe, expect, it } from "vitest";
import type { BoardItem } from "../../desktop/board-data.js";
import type { PublishTarget } from "../production/targets.js";
import type { ArticlePublishState } from "../wechat-article/publish-state.js";
import { groupThemes, type ThemeInput } from "./group.js";
import { defaultPlan, type DestinationPlan } from "./plan.js";

const tgt = (platform: string, state: PublishTarget["state"], reason?: string): PublishTarget => ({ platform, state, actions: [], ...(reason ? { reason } : {}) });

function item(id: string, extra: Partial<BoardItem> = {}): BoardItem {
  return {
    id, title: `稿 ${id}`, platform: "douyin", status: "publish_ready", topicId: null, column: "待发布", createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
    draftReadyAt: null, chars: 100, finalDurationMs: null, handoffHash: null, cover: null, publish: null, publishTime: null, lastError: null, blockedReason: null,
    missing: [], badges: [], alerts: [], reason: "", candidates: [], active: true, writing: false, targets: [], noScriptApproval: false, round: 1, derivedStale: null, kitPlatforms: [], ...extra,
  };
}

const plan = (platforms: string[], extra: Partial<DestinationPlan> = {}): DestinationPlan => ({ ...defaultPlan({ platforms }), ...extra });
const article = (s: Partial<ArticlePublishState>): ArticlePublishState => ({ superseded: [], attempts: [], ...s });

function run(items: BoardItem[], opts: { derived?: Record<string, { contentId: string; kind: "wechat_article" | "en_edition" }>; plans?: Record<string, DestinationPlan>; legacy?: Record<string, DestinationPlan>; articles?: Record<string, ArticlePublishState | Error> } = {}) {
  const input: ThemeInput = {
    items,
    contents: items.map((i) => ({ id: i.id, platform: i.platform ?? undefined, ...(opts.derived?.[i.id] ? { derivedFrom: { ...opts.derived[i.id], sourceCutHash: "h", at: "" } } : {}) })) as ThemeInput["contents"],
    plans: new Map([...Object.entries(opts.plans ?? {}).map(([k, v]) => [k, { plan: v, persisted: true }] as const),
      ...Object.entries(opts.legacy ?? {}).map(([k, v]) => [k, { plan: v, persisted: false, legacy: true }] as const)]),
    articles: new Map(Object.entries(opts.articles ?? {})),
    now: new Date("2026-10-25T00:00:00.000Z"),
  };
  return groupThemes(input);
}

const FOUR = ["douyin", "wechat_video", "xiaohongshu", "bilibili"];

describe("分组：父 = 源视频，子 = derivedFrom 指向它的稿", () => {
  it("公众号、英文版挂到源视频卡上，不单独出卡；稿件 id 不变", () => {
    const cards = run([item("v"), item("w", { platform: "wechat_mp", column: "写稿中", status: "drafting", targets: [] }), item("e", { platform: "youtube", column: "写稿中", status: "drafting" })],
      { derived: { w: { contentId: "v", kind: "wechat_article" }, e: { contentId: "v", kind: "en_edition" } }, plans: { v: plan([...FOUR, "wechat_mp", "youtube"]) } });
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("v");
    expect(cards[0].children.map((c) => c.id).sort()).toEqual(["e", "w"]);
  });
  it("不按标题猜：同标题的两条独立稿各自一张卡", () => {
    const cards = run([item("a", { title: "同名" }), item("b", { title: "同名" })], { plans: { a: plan(FOUR), b: plan(FOUR) } });
    expect(cards.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
  it("孤儿派生稿（父不在了）自己一张卡", () => {
    const cards = run([item("w", { platform: "wechat_mp", column: "待发布" })], { derived: { w: { contentId: "gone", kind: "wechat_article" } } });
    expect(cards).toMatchObject([{ id: "w", kind: "orphan" }]);
    expect(cards[0].destinations.map((d) => d.platform)).toEqual(["wechat_mp"]);
  });
  it("纯图文稿按它自己的阶段走", () => {
    const [c] = run([item("t", { platform: "wechat_mp", column: "写稿中", status: "drafting" })]);
    expect(c).toMatchObject({ kind: "text", column: "写稿" });
  });
  it("同一源视频两条同类派生稿：都列，带区分", () => {
    const cards = run([item("v"), item("w1", { platform: "wechat_mp" }), item("w2", { platform: "wechat_mp" })],
      { derived: { w1: { contentId: "v", kind: "wechat_article" }, w2: { contentId: "v", kind: "wechat_article" } }, plans: { v: plan(["douyin", "wechat_mp"]) } });
    const mp = cards[0].destinations.filter((d) => d.platform === "wechat_mp");
    expect(mp.map((d) => [d.content_id, d.tag])).toEqual([["w1", "第 1 篇"], ["w2", "第 2 篇"]]);
  });
});

describe("列：待发布 / 发布中 / 全部发完", () => {
  it("批完一个都没发 = 待发布", () => {
    const [c] = run([item("v", { targets: FOUR.map((p) => tgt(p, "未发")) })], { plans: { v: plan(FOUR) } });
    expect(c).toMatchObject({ column: "待发布", sent: 0, required: 4 });
  });
  it("至少一个已发 / 已定时、还有没发完的 = 发布中；3/5 已发只数已发", () => {
    const [c] = run([item("v", { column: "已发布", targets: [tgt("douyin", "已公开"), tgt("wechat_video", "待核"), tgt("xiaohongshu", "已公开"), tgt("bilibili", "已定时")] }), item("w", { platform: "wechat_mp" })],
      { derived: { w: { contentId: "v", kind: "wechat_article" } }, plans: { v: plan([...FOUR, "wechat_mp"]) }, articles: { w: article({ phase: "published", receipt: { scheduledAt: "2026-10-24T02:00:00.000Z", founderWords: "发了", published: true, at: "" } }) } });
    expect(c).toMatchObject({ column: "发布中", sent: 3, required: 5 });
    expect(c.exceptions).toEqual(["视频号 待你核对"]);
  });
  it("要发的全部已发 = 全部发完", () => {
    const [c] = run([item("v", { column: "已发布", targets: FOUR.map((p) => tgt(p, "已公开")) })], { plans: { v: plan(FOUR) } });
    expect(c.column).toBe("全部发完");
  });
  it("没定去向：不说全部发完，标「还没定发哪里」", () => {
    const [c] = run([item("v", { column: "已发布", targets: [tgt("douyin", "已公开")] })], { plans: { v: plan([]) } });
    expect(c.column).toBe("发布中");
    expect(c.exceptions).toContain("还没定发哪里");
    const [d] = run([item("v", { targets: [tgt("douyin", "未发")] })], { plans: { v: plan([]) } });
    expect(d.column).toBe("待发布");
  });
  it("全部被标了不出：全部发完（只在过了剪辑之后）", () => {
    const skipped = plan([], { destinations: Object.fromEntries(FOUR.map((p) => [p, { required: false, by: "founder", via: "board", founder_words: "这条不发了", at: "" }])) });
    const [c] = run([item("v", { targets: [tgt("douyin", "未发")] })], { plans: { v: skipped } });
    expect(c.column).toBe("全部发完");
    expect(c.plan.skipped).toHaveLength(4);
    const [e] = run([item("v", { column: "剪辑中", targets: [tgt("douyin", "未发")] })], { plans: { v: skipped } });
    expect(e.column).toBe("剪辑");
  });
  it("一个去向没发成（被驳回）：卡上标出来，不算已发", () => {
    const [c] = run([item("v", { column: "已发布", targets: [tgt("douyin", "已公开"), tgt("bilibili", "被驳回", "封面违规")] })], { plans: { v: plan(["douyin", "bilibili"]) } });
    expect(c).toMatchObject({ column: "发布中", sent: 1, required: 2 });
    expect(c.destinations.find((d) => d.platform === "bilibili")).toMatchObject({ state: "没发成", detail: "被驳回：封面违规" });
    expect(c.exceptions).toEqual(["B站 被驳回：封面违规"]);
  });
  it("公众号发了、视频还在剪：卡停在剪辑，公众号小标显示已发（文章回执不喂视频的 D1）", () => {
    const [c] = run([item("v", { column: "剪辑中", status: "editing", targets: [tgt("douyin", "未发")] }), item("w", { platform: "wechat_mp", column: "已发布" })],
      { derived: { w: { contentId: "v", kind: "wechat_article" } }, plans: { v: plan(["douyin", "wechat_mp"]) }, articles: { w: article({ phase: "published", receipt: { scheduledAt: "2026-10-24T02:00:00.000Z", founderWords: "发了", published: true, at: "" } }) } });
    expect(c.column).toBe("剪辑");
    expect(c.destinations.find((d) => d.platform === "wechat_mp")).toMatchObject({ state: "已发", at: "10-24" });
    expect(c.destinations.find((d) => d.platform === "douyin")?.state).toBe("没开始");
  });
  it("公众号定时过点没核到 = 待核（不标红）；推送失败 / 结果不明 = 没发成；读坏了照实标红", () => {
    const base = { derived: { w: { contentId: "v", kind: "wechat_article" as const } }, plans: { v: plan(["wechat_mp"]) } };
    const over = run([item("v"), item("w", { platform: "wechat_mp" })], { ...base, articles: { w: article({ phase: "scheduled", receipt: { scheduledAt: "2026-10-20T00:00:00.000Z", founderWords: "", published: false, at: "" } }) } });
    expect(over[0].destinations[0]).toMatchObject({ state: "待核", detail: "定时过了，等核对已发表" });
    expect(over[0].exceptions).toEqual([]);
    expect(over[0].column).toBe("发布中");
    for (const phase of ["failed", "unknown"] as const) {
      const r = run([item("v"), item("w", { platform: "wechat_mp" })], { ...base, articles: { w: article({ phase }) } });
      expect(r[0].destinations[0].state).toBe("没发成");
    }
    const bad = run([item("v"), item("w", { platform: "wechat_mp" })], { ...base, articles: { w: new Error("公众号发布状态读不出来（坏了）") } });
    expect(bad[0].destinations[0]).toMatchObject({ state: "没发成", detail: "公众号发布状态读不出来（坏了）" });
  });
});

describe("暂停与历史", () => {
  it("英文版源成片换了（isStale）：显示「等新成片」", () => {
    const [c] = run([item("v", { column: "已发布", targets: [tgt("douyin", "已公开")] }), item("e", { platform: "youtube", targets: [tgt("youtube", "未发"), tgt("x", "未发")], derivedStale: "源视频成片换了" })],
      { derived: { e: { contentId: "v", kind: "en_edition" } }, plans: { v: plan(["douyin", "youtube", "x"]) } });
    expect(c.destinations.filter((d) => d.platform === "youtube" || d.platform === "x").map((d) => [d.state, d.detail, d.paused])).toEqual([["在做", "等新成片", true], ["在做", "等新成片", true]]);
    expect(c.exceptions).toContain("YouTube 等新成片");
  });
  it("重拍后父稿回到录制：派生去向暂停，已发的保持已发", () => {
    const p = plan(["douyin", "wechat_mp", "youtube"], { reshoots: [{ round_ended: 1, round: 2, at: "", founder_words: "这条我觉得拍的不好 应该会重新拍", via: "board", published: [], to_cancel: [{ platform: "bilibili", content_id: "v" }] }] });
    const [c] = run([item("v", { column: "待录制", status: "approved", round: 2, targets: [tgt("douyin", "未发")] }), item("w", { platform: "wechat_mp", column: "已发布" }), item("e", { platform: "youtube", targets: [tgt("youtube", "未发")] })],
      { derived: { w: { contentId: "v", kind: "wechat_article" }, e: { contentId: "v", kind: "en_edition" } }, plans: { v: p },
        articles: { w: article({ phase: "published", receipt: { scheduledAt: "2026-10-24T00:00:00.000Z", founderWords: "", published: true, at: "" } }) } });
    expect(c.column).toBe("录制");
    expect(c.reshoot?.to_cancel).toEqual([{ platform: "bilibili", content_id: "v" }]);
    expect(c.destinations.find((d) => d.platform === "youtube")).toMatchObject({ detail: "等新成片", paused: true });
    expect(c.destinations.find((d) => d.platform === "wechat_mp")).toMatchObject({ state: "已发" });
  });
  it("取消勾选（计划里不要了）之后已发的照样显示，标成历史、不算进要发", () => {
    const p = plan(["douyin"], { destinations: { douyin: { required: true, by: "profile", at: "" }, bilibili: { required: false, by: "founder", via: "chat", founder_words: "B站不发了", at: "" } } });
    const [c] = run([item("v", { column: "已发布", targets: [tgt("douyin", "已公开"), tgt("bilibili", "已公开")] })], { plans: { v: p } });
    expect(c.destinations.find((d) => d.platform === "bilibili")).toMatchObject({ state: "已发", history: true, required: false });
    expect(c).toMatchObject({ column: "全部发完", sent: 1, required: 1 });
  });
  it("重拍过的视频：上一轮已发的中文平台照样已发（标上一轮）、不给发布动作、算进已发", () => {
    const p = plan(["douyin", "bilibili"], { reshoots: [{ round_ended: 1, round: 2, at: "", founder_words: "重拍", via: "board", published: [{ platform: "douyin", content_id: "v" }], to_cancel: [] }] });
    const unsent: PublishTarget = { platform: "douyin", state: "未发", actions: ["prepare_publish", "i_published"] };
    const [c] = run([item("v", { round: 2, targets: [unsent, tgt("bilibili", "未发")] })], { plans: { v: p } });
    expect(c.destinations.find((d) => d.platform === "douyin")).toMatchObject({ state: "已发", detail: "已发 · 上一轮" });
    expect(c.destinations.find((d) => d.platform === "douyin")?.actions).toBeUndefined();
    expect(c).toMatchObject({ sent: 1, required: 2, column: "发布中" });
  });
});

describe("真实资料库回归（2026-10-25 审计）", () => {
  const legacyBase = (extra: Partial<DestinationPlan> = {}): DestinationPlan => ({ version: 2, basis: [], created_at: "", destinations: {}, reshoots: [], ...extra });
  it("中文平台定时过点没核到（应已公开）= 待核：算投出（发布中），不算已发、不标红；确认公开的照样已发", () => {
    const [c] = run([item("v", { column: "已发布", targets: [tgt("douyin", "应已公开"), tgt("wechat_video", "应已公开"), tgt("xiaohongshu", "已公开"), tgt("bilibili", "应已公开")] })], { legacy: { v: legacyBase() } });
    expect(c.destinations.map((d) => [d.platform, d.state])).toEqual([["douyin", "待核"], ["wechat_video", "待核"], ["xiaohongshu", "已发"], ["bilibili", "待核"]]);
    expect(c.destinations[0].detail).toBe("应已公开，等核对");
    expect(c.column).toBe("发布中");
    expect([c.sent, c.required]).toEqual([1, 4]);
    expect(c.exceptions).toEqual([]);
  });
  it("真失败才是没发成：被驳回、读不到", () => {
    const [c] = run([item("v", { column: "已发布", targets: [tgt("douyin", "被驳回", "封面违规"), tgt("bilibili", "读不到"), tgt("xiaohongshu", "已公开")] })], { legacy: { v: legacyBase() } });
    expect(c.destinations.map((d) => d.state)).toEqual(["没发成", "已发", "没发成"]);
  });
  it("老主题默认 = 它实际有的：父视频的中文平台 + 真有的派生（公众号文章、英文版自己的平台）；没有的派生去向不算要发", () => {
    const [bare] = run([item("v", { column: "已发布", targets: FOUR.map((p) => tgt(p, "已公开")) })], { legacy: { v: legacyBase() } });
    expect(bare.plan.required).toEqual(FOUR);
    expect(bare.column).toBe("全部发完");
    expect(bare.destinations.some((d) => ["wechat_mp", "youtube", "x"].includes(d.platform))).toBe(false);
    const [full] = run([item("v", { column: "已发布", targets: FOUR.map((p) => tgt(p, "已公开")) }), item("w", { platform: "wechat_mp", column: "写稿中", status: "drafting" }), item("e", { platform: "youtube", column: "写稿中", status: "drafting", targets: [tgt("youtube", "未发")] })],
      { derived: { w: { contentId: "v", kind: "wechat_article" }, e: { contentId: "v", kind: "en_edition" } }, legacy: { v: legacyBase() } });
    expect(full.plan.required).toEqual([...FOUR, "wechat_mp", "youtube"]);
    expect(full.column).toBe("发布中");
  });
  it("老主题：创始人标的不出 / 恢复要发盖在「实际有的」上", () => {
    const at = "2026-10-24T00:00:00.000Z";
    const [c] = run([item("v", { column: "已发布", targets: [tgt("douyin", "已公开"), tgt("bilibili", "未发")] })],
      { legacy: { v: legacyBase({ destinations: { bilibili: { required: false, by: "founder", via: "board", founder_words: "B站不发", at }, x: { required: true, by: "founder", via: "board", founder_words: "这条发 X", at } } }) } });
    expect(c.plan.required).toEqual(["douyin", "x"]);
    expect(c.plan.skipped.map((s) => s.platform)).toEqual(["bilibili"]);
  });
  it("纯公众号稿没有 article-publish.json、稿件已在已发布：已发（与旧看板一致）", () => {
    const [c] = run([item("w", { platform: "wechat_mp", column: "已发布", status: "published", targets: [], publishTime: "2026-10-17T02:00:00.000Z" })]);
    expect(c.destinations[0]).toMatchObject({ platform: "wechat_mp", state: "已发" });
    expect(c.column).toBe("全部发完");
  });
});
