/** 选题会 spec §5：时区、指标级复核、发布计划绑定、作品标签 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { outcomeKey, shanghaiDate } from "./outcome-schema.js";
import { ageInDays, groupByEntity } from "./metrics-window.js";
import { importPerformanceRows } from "./row-import.js";
import { listOutcomes } from "./outcome-store.js";
import { commitBindings, readWorkTags, setWorkTag } from "./platform-items.js";
import { reviewedRow } from "../insights/metric-review.js";
import { gatherInsightsFacts } from "../insights/facts.js";
import { appendOutcomes } from "./outcome-store.js";
import { dropFixture, makeContent, makeFixture, row, writePlan, type Fixture } from "../meetings/meeting-fixture.test-helper.js";

describe("Asia/Shanghai 日期口径（§5.3）", () => {
  it("UTC 00:30Z 前后与 +08:00 的同一作品归为一个、天龄一致", () => {
    const csv = row({ platformTitle: "同一条", publishedAt: "2026-09-25T00:30:00+08:00", metricDate: "2026-10-02" });
    const auto = row({ platformTitle: "同一条", publishedAt: "2026-09-24T16:30:00Z", metricDate: "2026-10-03", source: "auto" });
    const groups = groupByEntity([csv, auto]);
    expect(groups).toHaveLength(1);
    expect(ageInDays(csv.publishedAt!, "2026-10-02")).toBe(7);
    expect(ageInDays(auto.publishedAt!, "2026-10-02")).toBe(7);
  });

  it("回归：现有 +08:00 与纯日期行的 outcomeKey 逐字不变", () => {
    const keys = [
      row({ platformTitle: "旧行 A", publishedAt: "2026-08-01T23:59:00+08:00" }),
      row({ platformTitle: "旧行 B", publishedAt: "2026-08-01T00:00:00+08:00" }),
      row({ platformTitle: "旧行 C", publishedAt: "2026-08-01" }),
      row({ platformTitle: "旧行 D", publishedAt: null }),
    ].map(outcomeKey);
    expect(keys).toEqual([
      "douyin:旧行a@2026-08-01:2026-09-26", "douyin:旧行b@2026-08-01:2026-09-26",
      "douyin:旧行c@2026-08-01:2026-09-26", "douyin:旧行d@unknown:2026-09-26",
    ]);
    expect(shanghaiDate("2026-08-01T16:00:00.000Z")).toBe("2026-08-02");
    expect(shanghaiDate("2026-08-01 10:00")).toBe("2026-08-01");
  });
});

describe("指标级复核（§5.3）", () => {
  it("只剔被点名的指标，播放和 5 秒完播留着；认不出的理由整行剔除", () => {
    const flagged = row({ platform: "wechat_video", metrics: { views: 900, completionRate: 0.3, completion5s: 41 }, needsReview: true, reviewReasons: ["完播率 0.3 低于 1%，确认导出值不是小数比例（如 0.325 = 32.5%）"] });
    expect(reviewedRow(flagged)?.metrics).toEqual({ views: 900, completion5s: 41 });
    // 抖音完播率 <1% 是长视频真值：存量行上的旧误报标记不再剔除它
    expect(reviewedRow({ ...flagged, platform: "douyin" })?.metrics).toEqual({ views: 900, completionRate: 0.3, completion5s: 41 });
    expect(reviewedRow(row({ needsReview: true, reviewReasons: ["别的什么问题"] }))).toBeNull();
    expect(reviewedRow(row({ metrics: { views: 0, likes: 3 }, needsReview: true, reviewReasons: ["播放为 0 但有互动，疑似读错字段"] }))?.metrics).toEqual({ likes: 3 });
  });

  it("账号洞察不再因一个可疑指标丢掉整行播放", async () => {
    const f = await makeFixture();
    try {
      await appendOutcomes([row({ metrics: { views: 900, completion5s: 0.3 }, needsReview: true, reviewReasons: ["5s完播率 0.3 低于 1%，确认导出值不是小数比例（如 0.325 = 32.5%）"] })], f.data);
      const facts = await gatherInsightsFacts({ days: 30 }, f.data, new Date("2026-09-27T00:00:00Z"));
      const douyin = facts.evidence.find((e) => e.ref === "platform:douyin")!.data as Record<string, any>;
      expect(douyin.usableWorks).toBe(1);
      expect(douyin.cumulative.totals.views.value).toBe(900);
      expect(douyin.cumulative.medians.completion5s).toBeUndefined();
      expect(douyin.unverifiedMetrics).toEqual([]);
    } finally { await dropFixture(f); }
  });
});

describe("抖音完播率量纲（2026-10-02 后台截图：长视频 0.63% 是真值）", () => {
  it("抖音完播率 <1% 不再转人工；其他平台/指标的 <1% 仍转人工", async () => {
    const { validateOutcome } = await import("./outcome-schema.js");
    const base = { publishedAt: "2026-09-28T10:00:00+08:00", metricDate: "2026-10-02" };
    expect(validateOutcome({ ...base, platform: "douyin", metrics: { views: 900, completionRate: 0.63, completion5s: 26.56 } })).toMatchObject({ ok: true, needsReview: false });
    expect(validateOutcome({ ...base, platform: "douyin", metrics: { completion5s: 0.5 } }).needsReview).toBe(true);
    expect(validateOutcome({ ...base, platform: "wechat_video", metrics: { completionRate: 0.63 } }).needsReview).toBe(true);
  });

  it("CSV：带 % 的 0.63% 原样是 0.63；0-1 小数比例 0.0063 换算成 0.63", async () => {
    const f = await makeFixture();
    try {
      const { importPerformanceCsv } = await import("./csv-import.js");
      const csv = "作品名称,发布时间,播放量,完播率,5s完播率\n长视频甲,2026-09-28 10:00,900,0.63%,26.56%\n长视频乙,2026-09-28 11:00,800,0.0063,0.2656\n";
      const report = await importPerformanceCsv("douyin", csv, "2026-10-02", f.data);
      expect(report.needsReview).toEqual([]);
      const rows = Object.fromEntries((await listOutcomes(f.data)).map((r) => [r.platformTitle, r.metrics]));
      expect(rows["长视频甲"]).toMatchObject({ completionRate: 0.63, completion5s: 26.56 });
      expect(rows["长视频乙"].completionRate).toBeCloseTo(0.63);
      expect(rows["长视频乙"].completion5s).toBeCloseTo(26.56);
    } finally { await dropFixture(f); }
  });
});

describe("发布计划按平台绑定（§5.2）+ 作品标签（§5.4）", () => {
  let f: Fixture;
  beforeEach(async () => { f = await makeFixture(); });
  afterEach(async () => { await dropFixture(f); });

  it("一条稿三平台不同标题：简报按各自 title + 北京日期都绑上；日期对不上的不认", async () => {
    const c = await makeContent(f.data, "稿件内部标题");
    await writePlan(f.data, c.id, [
      { platform: "douyin", title: "抖音：AI 越强你越忙", scheduled_at: "2026-09-30T18:00:00+08:00" },
      { platform: "xhs", title: "小红书版标题", scheduled_at: "2026-09-30T18:00:00+08:00" },
      { platform: "wechat_video", title: "视频号版标题", scheduled_at: "2026-09-30T18:00:00+08:00" },
    ]);
    await appendOutcomes([
      row({ platformTitle: "抖音：AI 越强你越忙", publishedAt: "2026-09-30T10:00:00Z", metricDate: "2026-10-01", source: "auto" }),
      row({ platform: "xiaohongshu", platformTitle: "小红书版标题", publishedAt: "2026-09-30T10:00:00Z", metricDate: "2026-10-01", source: "auto" }),
      row({ platform: "wechat_video", platformTitle: "视频号版标题", publishedAt: "2026-09-30T10:00:00Z", metricDate: "2026-10-01", source: "auto" }),
      row({ platformTitle: "抖音：AI 越强你越忙", publishedAt: "2026-08-01T10:00:00Z", metricDate: "2026-10-01", source: "auto" }),
    ], f.data);
    const { buildMeetingBrief } = await import("../meetings/meeting-brief.js");
    const works = (await buildMeetingBrief(f.data, new Date("2026-10-02T04:00:00Z"))).works;
    expect(works.filter((w) => w.contentId === c.id).map((w) => [w.platform, w.boundVia]).sort()).toEqual([["douyin", "plan"], ["wechat_video", "plan"], ["xiaohongshu", "plan"]]);
    expect(works.filter((w) => w.contentId === null)).toHaveLength(1);
  });

  it("回归 P1：加了发布计划之后再回流，早期未绑定快照和标签都还在（绑定只在内存里做）", async () => {
    const c = await makeContent(f.data, "稿件内部标题");
    const pull = (metricDate: string, views: number) => importPerformanceRows("xiaohongshu",
      [{ title: "小红书版", publishedAt: "2026-09-01T02:00:00Z", metrics: { views } }], { source: "auto", metricDate, dataDir: f.data });
    await pull("2026-09-04", 10);
    await pull("2026-09-08", 20);
    const { buildMeetingBrief } = await import("../meetings/meeting-brief.js");
    const now = new Date("2026-09-21T04:00:00Z");
    const key = (await buildMeetingBrief(f.data, now)).works[0].key;
    await setWorkTag(key, { format: "教学" }, f.data);
    await writePlan(f.data, c.id, [{ platform: "xhs", title: "小红书版", scheduled_at: "2026-09-01T10:00:00+08:00" }]);
    await pull("2026-09-20", 30);
    expect((await listOutcomes(f.data)).map((r) => r.metricDate).sort()).toEqual(["2026-09-04", "2026-09-08", "2026-09-20"]);
    const [w] = (await buildMeetingBrief(f.data, now)).works;
    // 2026-10-03 回流认领规格 ②：认领候选含发布计划里的平台与标题，这一行在入库时就归属了（boundVia=outcome），
    // 早期快照随之补挂（carryOverSnapshots），D+3/D+7 与标签照旧在
    expect(w).toMatchObject({ contentId: c.id, boundVia: "outcome", format: "教学", d3: { ageDays: 3 }, d7: { ageDays: 7 } });
  });

  it("发布计划里实际公开时间优先于计划时间", async () => {
    const { planEntriesOf } = await import("./plan-binding.js");
    const raw = JSON.stringify({ platforms: [{ platform: "douyin", title: "T", scheduled_at: "2026-09-30T18:00:00+08:00", publication: { published_at: "2026-10-01T09:00:00+08:00" } }] });
    expect(planEntriesOf("c", raw)[0].date).toBe("2026-10-01");
  });

  it("回归 P2b：有平台作品 id 的作品按 id 打标签，后来绑定到稿件也不失联", async () => {
    const c = await makeContent(f.data, "稿");
    await appendOutcomes([row({ platformTitle: "改过名之前", platformItemId: "777", publishedAt: "2026-09-01T02:00:00Z", metricDate: "2026-09-04" })], f.data);
    const { buildMeetingBrief } = await import("../meetings/meeting-brief.js");
    const now = new Date("2026-09-21T04:00:00Z");
    const key = (await buildMeetingBrief(f.data, now)).works[0].key;
    expect(key).toBe("douyin:item:777");
    await setWorkTag(key, { personaKey: "core" }, f.data);
    await appendOutcomes([row({ contentId: c.id, platformTitle: "改过名之后", platformItemId: "777", publishedAt: "2026-09-01T02:00:00Z", metricDate: "2026-09-08" })], f.data);
    const [w] = (await buildMeetingBrief(f.data, now)).works;
    expect(w).toMatchObject({ contentId: c.id, persona: "core", key: "douyin:item:777" });
  });

  it("回归 P2b：meeting_tag 拒收简报里没有的 work_key", async () => {
    const { executeInsights } = await import("../../tools/insights.js");
    const res = await executeInsights({ action: "meeting_tag", tag: { work_key: "douyin:不存在@2026-01-01", format: "教学" }, _dataDir: f.data });
    expect(res).toMatchObject({ ok: false });
    expect(String(res.error)).toContain("不在当前简报的作品里");
    expect(await readWorkTags(f.data)).toEqual({});
  });

  it("标签与绑定共用 platform-items.json，谁写都不抹掉对方", async () => {
    await setWorkTag("douyin:历史作品@2026-08-01", { format: "教学" }, f.data);
    await commitBindings([{ platform: "douyin", itemId: "123", contentId: "c-1", via: "title" }], f.data);
    await setWorkTag("douyin:历史作品@2026-08-01", { personaKey: "core" }, f.data);
    expect(await readWorkTags(f.data)).toMatchObject({ "douyin:历史作品@2026-08-01": { format: "教学", personaKey: "core" } });
    const file = JSON.parse(await fs.readFile(path.join(f.data, "platform-items.json"), "utf8"));
    expect(file.items["douyin:123"]).toMatchObject({ contentId: "c-1" });
  });
});
