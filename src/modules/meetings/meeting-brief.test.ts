import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { appendOutcomes } from "../flywheel/outcome-store.js";
import { setWorkTag } from "../flywheel/platform-items.js";
import { entityKey } from "../flywheel/metrics-window.js";
import { appendHypotheses, type Hypothesis } from "../retro/hypotheses.js";
import { buildMeetingBrief } from "./meeting-brief.js";
import { saveMeetingCas } from "./meeting-store.js";
import { executeInsights } from "../../tools/insights.js";
import { dropFixture, makeContent, makeFixture, makeTopic, row, writePlan, writePull, type Fixture } from "./meeting-fixture.test-helper.js";
import type { PerformanceOutcome } from "../flywheel/outcome-schema.js";

let f: Fixture;
const NOW = new Date("2026-10-02T04:00:00Z"); // 北京 10-02 12:00
beforeEach(async () => { f = await makeFixture(); });
afterEach(async () => { await dropFixture(f); });

/** 35 行一次性累计快照（形同 09-26 CSV + 09-24 B 站之外的历史账）：抖音 25 + 小红书 10，含一条爆款 */
function historical(): PerformanceOutcome[] {
  const douyin = Array.from({ length: 25 }, (_, i) => row({
    platformTitle: `历史抖音 ${i + 1}`, publishedAt: `2026-08-${String(i + 1).padStart(2, "0")}T20:00:00+08:00`,
    metrics: { views: i === 0 ? 320_000 : 1000 + i * 100, completion5s: 30 + i },
  }));
  const xhs = Array.from({ length: 10 }, (_, i) => row({
    platform: "xiaohongshu", platformTitle: `历史小红书 ${i + 1}`, publishedAt: `2026-08-${String(i + 1).padStart(2, "0")}T12:00:00+08:00`,
    metrics: { views: 50 + i, likes: i },
  }));
  return [...douyin, ...xhs];
}

/** 6 个回流作品的多天快照：D+3（第 6 个缺）与 D+7（第 6 个只有 D+8，容差内） */
function multiDay(): PerformanceOutcome[] {
  return Array.from({ length: 6 }, (_, i) => {
    const pub = `2026-09-1${i}T02:00:00Z`;
    const at = (age: number) => `2026-09-${String(10 + i + age).padStart(2, "0")}`;
    const base = { platformTitle: `回流 ${i + 1}`, publishedAt: pub, source: "auto" as const };
    const d7 = row({ ...base, metricDate: at(i === 5 ? 8 : 7), metrics: { views: (i + 1) * 100, ...(i < 3 ? { completion5s: 40 + i } : {}) } });
    return i === 5 ? [d7] : [row({ ...base, metricDate: at(3), metrics: { views: (i + 1) * 50 } }), d7];
  }).flat();
}

describe("meeting_brief 确定性层（固定数据集）", () => {
  it("健康度、基线、分组、离群都按口径精确算出", async () => {
    await appendOutcomes([...historical(), ...multiDay()], f.data);
    await writePull(f.data, { douyin: { enabled: true, lastSuccessAt: "2026-10-01T20:00:00Z" }, wechat_video: { enabled: true, lastSuccessAt: "2026-09-28T00:00:00Z" } });
    for (const i of [1, 2, 3]) await setWorkTag(entityKey(row({ platformTitle: `回流 ${i}`, publishedAt: `2026-09-1${i - 1}T02:00:00Z` })), { format: "教学" }, f.data);
    const brief = await buildMeetingBrief(f.data, NOW);
    expect(brief.health.platforms.map((p) => p.status)).toEqual(["正常", "过期", "未开启"]);
    expect(brief.health.coldStart).toBe(false);
    expect(brief.outliers.map((w) => w.title)).toEqual(["历史抖音 1"]);
    const base = (metric: string, day: number, platform = "douyin") => brief.baselines.find((b) => b.platform === platform && b.metric === metric && b.day === day)!.stat;
    expect(base("views", 7)).toEqual({ n: 6, status: "ok", median: 350 });
    expect(base("views", 3)).toEqual({ n: 5, status: "ok", median: 150 });
    expect(base("completion5s", 7)).toEqual({ n: 3, status: "insufficient", values: [40, 41, 42] });
    expect(base("views", 7, "xiaohongshu")).toEqual({ n: 0, status: "insufficient", values: [] });
    const w6 = brief.works.find((w) => w.title === "回流 6")!;
    expect(w6.d7).toMatchObject({ ageDays: 8 });
    const teach = brief.groups.find((g) => g.dimension === "format" && g.key === "教学" && g.day === 7 && g.metric === "views")!;
    expect(teach.stat).toEqual({ n: 3, status: "insufficient", values: [100, 200, 300] });
    // 只标了形式、画像还缺的照样列进未标
    expect(brief.untagged.length).toBe(41);
    expect(brief.untagged.filter((u) => u.format === "教学").map((u) => u.persona)).toEqual(["未标", "未标", "未标"]);
  });

  it("冷启动：只有一次性累计快照时基线全 insufficient，顶部写明不拿累计冒充同龄（边界 2）", async () => {
    await appendOutcomes(historical(), f.data);
    const brief = await buildMeetingBrief(f.data, NOW);
    expect(brief.health.coldStart).toBe(true);
    expect(brief.baselines.every((b) => b.stat.status === "insufficient")).toBe(true);
    expect(brief.attention.join("\n")).toContain("冷启动");
    expect(brief.attention.join("\n")).toContain("抖音回流未开启");
  });

  it("读数据失败就报原始错误，不出半份简报（边界 12）", async () => {
    await fs.writeFile(path.join(f.data, "outcomes.jsonl"), "{坏行\n");
    await expect(buildMeetingBrief(f.data, NOW)).rejects.toThrow(/outcomes\.jsonl 第 1 行/);
    const res = await executeInsights({ action: "meeting_brief", _dataDir: f.data });
    expect(res).toMatchObject({ ok: false });
    expect(String(res.next_action)).toContain("不凭记忆开会");
  });
});

describe("上次下注对账", () => {
  async function bet(topicId: string, slotId: string, platform: string): Promise<Hypothesis> {
    return { id: `hyp-meeting-2026-09-25-${slotId}`, statement: "这条会高于中位数", metricFocus: "views", direction: "up", scope: { platform },
      contentIds: [], proposedAt: "2026-09-25T02:00:00Z", retroRunId: "meeting-2026-09-25", status: "open",
      topicId, meetingDate: "2026-09-25", slotId, probability: 60, premortem: "选题太窄", watchDay: 7 };
  }

  it("中 / 数据不够（回流过期，边界 1）/ 无法对账（边界 9）/ 未到期 各自判对", async () => {
    await appendOutcomes(multiDay(), f.data);
    await writePull(f.data, { douyin: { enabled: true, lastSuccessAt: "2026-10-01T20:00:00Z" }, wechat_video: { enabled: true, lastSuccessAt: "2026-09-20T00:00:00Z" } });
    const [t1, t2, t3, t4] = await Promise.all(["中的题", "过期的题", "绑不上的题", "没发的题"].map((t) => makeTopic(f.data, t)));
    const c1 = await makeContent(f.data, "中的稿", { topicId: t1.id });
    const c2 = await makeContent(f.data, "过期的稿", { topicId: t2.id, platform: "wechat_video" });
    const c3 = await makeContent(f.data, "绑不上的稿", { topicId: t3.id });
    await makeContent(f.data, "没发的稿", { topicId: t4.id }, "drafting");
    await writePlan(f.data, c3.id, [{ platform: "douyin", title: "抖音上的另一个标题", scheduled_at: "2026-09-24T18:00:00+08:00" }]);
    // UTC 09-24 16:30 = 北京 09-25 00:30：按北京日 10-02 正好 D+7（UTC 口径会算成 D+8）
    await appendOutcomes([
      row({ contentId: c1.id, platformTitle: "中的稿", publishedAt: "2026-09-24T16:30:00Z", metricDate: "2026-10-02", metrics: { views: 1000 }, source: "auto" }),
      row({ contentId: c2.id, platform: "wechat_video", platformTitle: "过期的稿", publishedAt: "2026-09-24T02:00:00Z", metricDate: "2026-10-01", metrics: { views: 10 }, source: "auto" }),
    ], f.data);
    await appendHypotheses([await bet(t1.id, "s1", "douyin"), await bet(t2.id, "s2", "wechat_video"), await bet(t3.id, "s3", "douyin"), await bet(t4.id, "s4", "douyin")], f.data);
    await saveMeetingCas({ date: "2026-09-25", slots: [], rejected: [], reviews: [] }, 0, f.data);
    const { pendingBets } = await buildMeetingBrief(f.data, NOW);
    expect(pendingBets.meetingDate).toBe("2026-09-25");
    const v = Object.fromEntries(pendingBets.bets.map((b) => [b.slotId, b]));
    expect(v.s1).toMatchObject({ verdict: "中", contentIds: [c1.id] });
    expect(v.s1.judge?.evidence).toMatchObject({ testValue: 1000, baselineValue: 350, baselineSampleSize: 6 });
    expect(v.s2).toMatchObject({ verdict: "数据不够" });
    expect(v.s2.reason).toContain("视频号回流过期");
    expect(v.s3).toMatchObject({ verdict: "无法对账", unmatched: [{ contentId: c3.id, title: "抖音上的另一个标题", date: "2026-09-24" }] });
    expect(v.s4.verdict).toBe("未到期");
  });
});
