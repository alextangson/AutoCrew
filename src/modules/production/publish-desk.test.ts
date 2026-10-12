/**
 * 发布台（spec 2026-10-12 发布台）后端：读模型的各平台行、比平时、回流原因、进度栏，两个新写操作（补链接、手填数据）。
 * 对应边界清单 1–14（按吸收 1–16 修订）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import type { Content, VideoKit } from "../../storage/local-store.js";
import type { PlatformPublication } from "../../storage/publish-record.js";
import { readProductionDoc, writeProductionDoc } from "../../storage/production-store.js";
import type { Fact } from "../../storage/production-types.js";
import { compareViews, comparisonText, platformBaselines } from "../flywheel/compare.js";
import { backflowOf } from "../flywheel/backflow.js";
import { defaultPullState } from "../flywheel/pull-state.js";
import type { DataRow, Work } from "../flywheel/data-rows.js";
import { listOutcomes } from "../flywheel/outcome-store.js";
import { deskRow, type RowInput } from "./desk-rows.js";
import { railSteps } from "./desk-rail.js";
import { BODY, coverOk, cutOk, decision, doc, fact, fullFacts, script } from "./derive-fixtures.js";
import type { PublishTarget } from "./targets.js";
import type { Slot } from "./receipts.js";
import { founderDecision } from "./decisions.js";
import { decide } from "./inbox-decide.js";
import { publishDesk } from "./publish-desk.js";
import { founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

const NOW = Date.parse("2026-10-12T12:00:00+08:00");
const work = (platform: string, id: string | null, views: number, recordedAt = "2026-10-11T10:00:00.000Z"): Work => ({
  key: `${platform}#${id}`, platform, title: "t", publishedAt: null, day: null, platformItemId: id, importedContentId: null,
  snapshots: [{ metricDate: "2026-10-11", recordedAt, source: "auto", metrics: { views, likes: 3, comments: 1 } }],
});
const row = (...works: Work[]): DataRow => ({ id: `r${Math.random()}`, contentId: null, contentTitle: null, title: "t", day: null, works, publishedOn: [], link: "none", decisionId: null });
const target = (platform: string, state: PublishTarget["state"], extra: Partial<PublishTarget> = {}): PublishTarget => ({ platform, state, actions: [], ...extra });
const slot = (platform: string, extra: Partial<Slot> = {}): Slot => ({ id: `slot:1:${platform}`, round: 1, platform, pub_state: "public", verified: true, by: "trusted", fact_id: "f1", source: "plan", evidence: "发布计划里的记录", at: "2026-10-10T10:00:00.000Z", history: [], ...extra });
const kit = (platform: string, extra: Partial<VideoKit> = {}): VideoKit => ({ platform, postTitle: `${platform}标题`, caption: "简介正文 #AI #效率", storyboard: [], coverText: "", coverPrompt: "", generatedAt: "", ...extra });
const content = (extra: Partial<Content> = {}) => ({ id: "content-x", title: "稿", body: BODY, platform: "douyin", hashtags: [], ...extra }) as unknown as Content;
const entry = (platform: string, extra: Partial<PlatformPublication> = {}): PlatformPublication => ({ platform, state: "public", submitted: true, raw: null, review: null, time: null, reason: null, url: null, campaigns: [], manual: null, ...extra });
const okPull = () => { const s = defaultPullState(); for (const p of Object.values(s.platforms)) { p.enabled = true; p.lastStatus = "ok"; p.lastSuccessAt = "2026-10-12T00:00:00Z"; } return s; };
const input = (i: Partial<RowInput> & { target: PublishTarget }): RowInput => ({ content: content(), slot: null, entry: undefined, overdue: null, works: [], baselines: new Map(), backflow: backflowOf(i.target.platform, okPull()), now: NOW, ...i });

describe("比平时 = 数据页口径（吸收 1 / 边界 7）", () => {
  const rows = [row(work("douyin", "a", 100)), row(work("douyin", "b", 200)), row(work("douyin", "c", 300)), row(work("bilibili", "x", 50))];
  it("每行最新累计播放的中位数，样本 ≥3 才比；高 / 低 / 差不多；样本不足不比", () => {
    const b = platformBaselines(rows);
    expect(b.get("douyin")).toEqual({ median: 200, samples: 3 });
    expect(comparisonText(compareViews(280, b.get("douyin")), "抖音")).toEqual({ text: "比你抖音的中位数高 40%", tone: "up" });
    expect(comparisonText(compareViews(100, b.get("douyin")), "抖音").text).toBe("比你抖音的中位数低 50%");
    expect(comparisonText(compareViews(205, b.get("douyin")), "抖音").tone).toBe("flat");
    expect(comparisonText(compareViews(80, b.get("bilibili")), "B站").text).toBe("历史太少，不比");
  });
});

describe("回流原因分类（吸收 10 / 边界 5）", () => {
  it("B站不支持、未开启、登录过期、抓取失败、正常", () => {
    const s = defaultPullState();
    expect(backflowOf("bilibili", s).kind).toBe("unsupported");
    expect(backflowOf("douyin", s)).toMatchObject({ kind: "off", auto: false });
    s.platforms.wechat_video = { ...s.platforms.wechat_video, enabled: true, lastStatus: "needs_login" };
    expect(backflowOf("wechat_video", s).text).toBe("视频号登录过期，去 ego lite 登录后自动接上");
    s.platforms.xiaohongshu = { ...s.platforms.xiaohongshu, enabled: true, lastStatus: "timeout" };
    expect(backflowOf("xiaohongshu", s)).toMatchObject({ kind: "failed", auto: true });
    expect(backflowOf("douyin", null, "EACCES").kind).toBe("unreadable");
  });
});

describe("各平台一行（deskRow）", () => {
  it("边界 1：没发布计划 = 未发 + 让 Codex 发；标已发在「更多」", () => {
    const r = deskRow(input({ target: target("douyin", "未发", { actions: ["prepare_publish", "i_published"] }) }));
    expect(r).toMatchObject({ status: "未发", action: { kind: "prepare_publish", label: "让 Codex 发" }, more: ["i_published"], data: { why: "not_public", text: "公开后回流" } });
  });
  it("边界 2：发布包没备 / 过期不显示旧文案；有包显示拟发、标签拆出", () => {
    expect(deskRow(input({ target: target("douyin", "未发") })).copy).toEqual({ kind: "missing", text: "发布包还没备" });
    const stale = content({ videoKits: { douyin: kit("douyin", { draftHash: "old" }) } });
    expect(deskRow(input({ content: stale, target: target("douyin", "未发") })).copy.kind).toBe("stale");
    const ok = deskRow(input({ content: content({ videoKits: { douyin: kit("douyin") } }), target: target("douyin", "未发") })).copy;
    expect(ok).toEqual({ kind: "ready", source: "拟发", title: "douyin标题", caption: "简介正文", tags: ["AI", "效率"] });
  });
  it("吸收 11：已投出显示实发（计划里的标题 / 简介 / 标签）", () => {
    const r = deskRow(input({ target: target("douyin", "已定时"), entry: entry("douyin", { state: "scheduled", scheduledAt: "2026-10-20T10:00:00Z", title: "实发标题", caption: "实发简介", tags: ["实发"] }) }));
    expect(r.copy).toEqual({ kind: "ready", source: "实发", title: "实发标题", caption: "实发简介", tags: ["实发"] });
    expect(r.status).toBe("定时 10-20 18:00");
    expect(r.when).toBe("还有 8 天公开");
  });
  it("边界 3 / 吸收 6：定时过了没核到 = 应已公开 · 还没核到；只有 24h 追问成立才给确认发了（带 fact_id）", () => {
    const past = { target: target("douyin", "已定时"), slot: slot("douyin", { pub_state: "scheduled", at: "2026-10-11T10:00:00Z", published_at: "2026-10-11T10:00:00Z", by: "accepted" }) };
    expect(deskRow(input(past))).toMatchObject({ state: "应已公开", status: "应已公开 · 还没核到", action: null });
    const asked = deskRow(input({ ...past, overdue: { id: "fact-claim" } as never }));
    expect(asked.action).toEqual({ kind: "confirm_receipt", label: "确认发了", fact_id: "fact-claim" });
  });
  it("吸收 2：按标题认的是待核，不是已公开；可信公开没链接 = 已公开（没有作品链接），更多里补链接", () => {
    const guessed = deskRow(input({ target: target("douyin", "待核", { fact_id: "f9", actions: ["confirm_receipt", "correct_publish"] }), slot: slot("douyin", { verified: false, by: "pending", source: "metrics_title", evidence: "数据回流按标题猜是这条" }) }));
    expect(guessed).toMatchObject({ status: "待核：数据回流按标题猜是这条", action: { kind: "confirm_receipt", fact_id: "f9" }, data: { why: "not_public" } });
    const noLink = deskRow(input({ target: target("douyin", "已公开", { actions: ["correct_publish"] }), slot: slot("douyin") }));
    expect(noLink.status).toBe("已公开（没有作品链接）");
    expect(noLink.more).toEqual(["add_work_url", "correct_publish"]);
    expect(noLink.data).toMatchObject({ why: "no_identity" });
  });
  it("吸收 3：按本轮槽的作品 id 取数据；对上多件 = 对不上；回流正常但没对上 / 刚公开", () => {
    const pub = { target: target("douyin", "已公开", { url: "https://www.douyin.com/video/111" }), slot: slot("douyin", { url: "https://www.douyin.com/video/111" }) };
    const base = new Map([["douyin", { median: 100, samples: 5 }]]);
    const one = deskRow(input({ ...pub, works: [work("douyin", "111", 150), work("douyin", "222", 9)], baselines: base }));
    expect(one.data).toMatchObject({ kind: "metrics", views: 150, likes: 3, comments: 1, compare: { text: "比你抖音的中位数高 50%" } });
    expect(deskRow(input({ ...pub, works: [work("douyin", "111", 1), { ...work("douyin", "111", 2), key: "dup" }] })).data).toMatchObject({ why: "mismatch" });
    expect(deskRow(input({ ...pub, works: [work("douyin", "222", 9)] })).data).toMatchObject({ why: "unmatched" });
    const fresh = deskRow(input({ ...pub, entry: entry("douyin", { time: "2026-10-12T01:00:00Z", publishedAt: "2026-10-12T01:00:00Z" }) }));
    expect(fresh.data).toEqual({ kind: "note", why: "fresh", text: "公开 3 小时，数据还没回来" });
    expect(fresh.when).toBe("公开第 1 天");
  });
  it("Codex 审 P2-4：计划里只有核实时间（没有 published_at）= 不知道实际公开时间；观察时间取 seen_at", () => {
    const r = deskRow(input({ target: target("douyin", "已公开", { url: "https://www.douyin.com/video/111" }), slot: slot("douyin", { url: "https://www.douyin.com/video/111", seen_at: "2026-10-11T00:00:00Z" }), entry: entry("douyin", { time: "2026-10-12T01:00:00Z", publishedAt: null }) }));
    expect(r.times).toMatchObject({ public_at: null, observed_at: "2026-10-11T00:00:00Z" });
    expect(r.when).toBe("不知道实际公开时间");
  });
  it("Codex 审 P2-6：有快照但回流登录过期 = 照样给数字，并带上怎么接上", () => {
    const pull = defaultPullState();
    pull.platforms.douyin = { ...pull.platforms.douyin, enabled: true, lastStatus: "needs_login" };
    const r = deskRow(input({ target: target("douyin", "已公开", { url: "https://www.douyin.com/video/111" }), slot: slot("douyin", { url: "https://www.douyin.com/video/111" }), works: [work("douyin", "111", 50)], backflow: backflowOf("douyin", pull) }));
    expect(r.data).toMatchObject({ kind: "metrics", views: 50, metric_date: "2026-10-11", warning: "抖音登录过期，去 ego lite 登录后自动接上" });
  });
  it("边界 5：回流断了写原因，不写 0；B站不回流时更多里能手填", () => {
    const pull = defaultPullState();
    pull.platforms.wechat_video = { ...pull.platforms.wechat_video, enabled: true, lastStatus: "needs_login" };
    const wv = deskRow(input({ target: target("wechat_video", "已公开", { url: "https://channels.weixin.qq.com/x?objectId=9" }), slot: slot("wechat_video", { item_id: "9" }), backflow: backflowOf("wechat_video", pull) }));
    expect(wv.data).toMatchObject({ why: "login", text: "视频号登录过期，去 ego lite 登录后自动接上" });
    const bili = deskRow(input({ target: target("bilibili", "已公开", { url: "https://www.bilibili.com/video/BV1xx411c7mD" }), slot: slot("bilibili", { url: "https://www.bilibili.com/video/BV1xx411c7mD" }), backflow: backflowOf("bilibili", pull) }));
    expect(bili.data).toMatchObject({ why: "unsupported" });
    expect(bili.more).toContain("record_metrics");
    expect(wv.more).not.toContain("record_metrics");
  });
  it("被驳回 = 重新提交 + 原因；活动名来自计划", () => {
    const r = deskRow(input({ target: target("xiaohongshu", "被驳回", { reason: "封面违规", actions: ["resubmit", "correct_publish"] }), entry: entry("xiaohongshu", { state: "rejected", campaigns: ["谁在用AI干活"] }) }));
    expect(r).toMatchObject({ status: "被驳回：封面违规", action: { kind: "resubmit" }, campaigns: ["谁在用AI干活"], tone: "bad" });
  });
});

describe("进度栏（吸收 12 / 边界 13）", () => {
  const steps = (facts: Fact[], decisions: Parameters<typeof doc>[1], extra: { firstSubmitAt?: string; firstDataAt?: string } = {}) =>
    railSteps({ doc: { ...doc(facts, []), decisions }, body: BODY, firstSubmitAt: extra.firstSubmitAt ?? null, firstDataAt: extra.firstDataAt ?? null }).map((s) => `${s.label}:${s.state}${s.current ? "*" : ""}`);
  it("全走完：每步完成；数据没回来时当前在数据", () => {
    expect(steps([fact("aroll", "a", { state: "accepted" }), ...fullFacts()], [script(), cutOk(), coverOk()], { firstSubmitAt: "2026-10-10T00:00:00Z" }))
      .toEqual(["写稿:完成", "录制:完成", "剪辑:完成", "封面:完成", "发布:完成", "数据:进行中*"]);
  });
  it("导入的稿没认稿就剪了：写稿 = 没有记录，不画成完成", () => {
    expect(steps([fact("aroll", "a", { state: "accepted" }), ...fullFacts()], [cutOk()])).toEqual(["写稿:没有记录", "录制:完成", "剪辑:完成", "封面:进行中*", "发布:未到", "数据:未到"]);
  });
  it("成片被打回 = 被退回（带原因），是当前一步", () => {
    const r = railSteps({ doc: doc([fact("aroll", "a", { state: "accepted" }), ...fullFacts()], [script(), decision("cut_reject", { note: "开头太慢" })]), body: BODY, firstSubmitAt: null, firstDataAt: null });
    expect(r[2]).toMatchObject({ state: "被退回", note: "开头太慢", current: true });
  });
});

describe("读模型与两个新写操作（端到端）", () => {
  let env: Env;
  beforeEach(async () => { env = await makeEnv({ enabled: true }); });
  afterEach(async () => { await env.cleanup(); });

  async function live(facts: Partial<Fact>[]) {
    const c = await videoContent(env, "Alovers 测试");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "Alovers 测试-原片.mov"), "raw"), request_id: "a" });
    const d = (await readProductionDoc(c.id, env.dir))!;
    for (const f of facts) d.facts.push({ id: `fact-${d.facts.length}`, kind: "publish", round: d.round, state: "accepted", availability: "present", source: "reconcile", at: "2026-10-10T10:00:00Z", seen_at: "2026-10-10T10:00:00Z", obs_source: "plan", verified: true, pub_state: "public", evidence: "发布计划里的记录", ...f } as Fact);
    await writeProductionDoc(c.id, env.dir, d, d.revision);
    return c;
  }

  it("边界 1 / 11：没计划 = 稿件平台一行未发；计划读不到 = plan_error，不说成未发；文字稿 / 未启用 active:false", async () => {
    const c = await live([]);
    const r = await publishDesk(c.id, env.dir) as { active: boolean; desk: { rows: Array<{ platform: string; status: string }>; plan_error: string | null; script: { label: string }; rail: { steps: unknown[] } } };
    expect(r.active).toBe(true);
    expect(r.desk.rows.map((x) => [x.platform, x.status])).toEqual([["douyin", "未发"]]);
    expect(r.desk.script.label).toBe("定稿");
    expect(r.desk.rail.steps).toHaveLength(6);
    await put(path.join(projectRoot(env, c.id), "06-publish/publish-plan.json"), "{坏的");
    const bad = await publishDesk(c.id, env.dir) as { desk: { plan_error: string; rows: Array<{ state: string }> } };
    expect(bad.desk.plan_error).toBe("发布记录不是合法 JSON");
    expect(bad.desk.rows[0].state).not.toBe("未发");
  });

  it("吸收 5：补链接按槽、服务端校验是这个平台的作品链接、带轮次；模型调用被拒；不改状态", async () => {
    const c = await live([{ platform: "douyin" }]);
    expect(await decide(c.id, "add_work_url", { platform: "douyin", round: 1, url: "https://www.douyin.com/video/7", _modelCall: true }, env.dir)).toMatchObject({ ok: false, code: "founder_only" });
    expect(await founderDecision(c.id, "add_work_url", { platform: "douyin", round: 1, url: "https://www.xiaohongshu.com/explore/64a1b2c3d4e5" }, env.dir)).toMatchObject({ ok: false, code: "bad_url" });
    expect(await founderDecision(c.id, "add_work_url", { platform: "douyin", round: 2, url: "https://www.douyin.com/video/7" }, env.dir)).toMatchObject({ ok: false, code: "stale" });
    expect(await founderDecision(c.id, "add_work_url", { platform: "xiaohongshu", round: 1, url: "https://www.xiaohongshu.com/explore/64a1b2c3d4e5" }, env.dir)).toMatchObject({ ok: false, code: "no_slot" });
    expect(await decide(c.id, "add_work_url", { platform: "douyin", round: 1, url: "https://www.douyin.com/video/7" }, env.dir)).toMatchObject({ ok: true });
    // Codex 审 P1：已指认一件作品后，换成另一件的链接拒（先纠正），不混
    expect(await founderDecision(c.id, "add_work_url", { platform: "douyin", round: 1, url: "https://www.douyin.com/video/8" }, env.dir)).toMatchObject({ ok: false, code: "work_conflict" });
    const r = await publishDesk(c.id, env.dir) as { desk: { rows: Array<{ status: string; url: string }> } };
    expect(r.desk.rows[0]).toMatchObject({ status: "已公开", url: "https://www.douyin.com/video/7" });
  });

  it("吸收 4：手填数据带平台 + 作品 + 日期 + 轮次；自动回流的平台不收；记上后行里出数字", async () => {
    const c = await live([{ platform: "bilibili", url: "https://www.bilibili.com/video/BV1xx411c7mD" }]);
    const ask = (p: Record<string, unknown>) => founderDecision(c.id, "record_metrics", { platform: "bilibili", round: 1, metric_date: "2026-10-11", metrics: { views: 1200, likes: 30, comments: 4 }, expected_work_id: "BV1xx411c7mD", ...p }, env.dir);
    // Codex 审 P2-5：页面看到的作品对不上 = stale
    expect(await ask({ expected_work_id: "BV1other0000" })).toMatchObject({ ok: false, code: "stale" });
    expect(await ask({ round: undefined })).toMatchObject({ ok: false, code: "round_required" });
    expect(await ask({ metric_date: "2099-01-01" })).toMatchObject({ ok: false, code: "bad_date" });
    expect(await ask({ metrics: { views: -1 } })).toMatchObject({ ok: false, code: "bad_metrics" });
    expect(await ask({ _host: "codex" })).toMatchObject({ ok: false, code: "founder_only" });
    expect(await ask({})).toMatchObject({ ok: true });
    const o = (await listOutcomes(env.dir)).find((x) => x.contentId === c.id)!;
    expect(o).toMatchObject({ platform: "bilibili", platformItemId: "BV1xx411c7mD", metricDate: "2026-10-11", source: "paste" });
    // Codex 审 P2-3：没有明写的公开时间就不编 publishedAt
    expect(o.publishedAt ?? null).toBeNull();
    const r = await publishDesk(c.id, env.dir) as { desk: { rows: Array<{ data: { kind: string; views?: number } }>; rail: { steps: Array<{ key: string; state: string }> } } };
    expect(r.desk.rows[0].data).toMatchObject({ kind: "metrics", views: 1200 });
    expect(r.desk.rail.steps.find((s) => s.key === "data")!.state).toBe("完成");
  });

  it("Codex 审 P2-3：你标的已发布（确认时间晚于数据日期）照样收更早的数据", async () => {
    const c = await live([]);
    expect(await founderDecision(c.id, "i_published", { platform: "bilibili", round: 1, url: "https://www.bilibili.com/video/BV1xx411c7mD" }, env.dir)).toMatchObject({ ok: true });
    expect(await founderDecision(c.id, "record_metrics", { platform: "bilibili", round: 1, metric_date: "2020-01-01", metrics: { views: 5 }, expected_work_id: "BV1xx411c7mD" }, env.dir)).toMatchObject({ ok: true });
  });

  it("Codex 审 P2-2：重开后计划里那条（提交早于重开）不当本轮的活动 / 实发文案 / 时间", async () => {
    const c = await live([{ platform: "douyin" }]);
    await put(path.join(projectRoot(env, c.id), "06-publish/publish-plan.json"), JSON.stringify({ platforms: [{ platform: "douyin", title: "上一轮标题", caption: "上一轮简介", campaigns: [{ name: "旧活动", selected: true }], publication: { status: "published", published_at: "2026-10-01T10:00:00Z", submitted_at: "2026-10-01T09:00:00Z" } }] }));
    const { reopenScript } = await import("./reopen.js");
    expect(await reopenScript(c.id, env.dir, undefined, 1)).toMatchObject({ ok: true });
    expect(await founderDecision(c.id, "i_published", { platform: "douyin", round: 2 }, env.dir)).toMatchObject({ ok: true });
    const r = await publishDesk(c.id, env.dir) as { desk: { rows: Array<{ campaigns: string[]; copy: { kind: string; source?: string }; times: { public_at: string | null } }> } };
    expect(r.desk.rows[0]).toMatchObject({ campaigns: [], times: { public_at: null } });
    expect(r.desk.rows[0].copy.source).not.toBe("实发");
  });

  it("边界 8：重开后表只显示本轮，上一轮进「以前的发布」", async () => {
    const c = await live([{ platform: "douyin" }]);
    expect(await founderDecision(c.id, "i_published", { platform: "bilibili", round: 1 }, env.dir)).toMatchObject({ ok: true });
    const { reopenScript } = await import("./reopen.js");
    expect(await reopenScript(c.id, env.dir, undefined, 1)).toMatchObject({ ok: true });
    const r = await publishDesk(c.id, env.dir) as { desk: { round: number; rows: Array<{ state: string }>; past: unknown[] } };
    expect(r.desk.round).toBe(2);
    expect(r.desk.rows.every((x) => x.state === "未发")).toBe(true);
    expect(r.desk.past.length).toBeGreaterThanOrEqual(2);
  });
});
