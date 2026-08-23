/**
 * metrics-window.test.ts —— 复盘时间口径三视图(spec §5.2)。
 * 全纯函数,零 IO:构造快照流 → 断言口径。重点锁死的是「累计快照不许当本期表现」。
 */
import { describe, it, expect } from "vitest";
import {
  deltaInWindow,
  publishCohort,
  metricsAtAge,
  metricsAtAgeAll,
  groupByEntity,
  computeRates,
  median,
  ageInDays,
} from "./metrics-window.js";
import type { OutcomeMetrics, PerformanceOutcome } from "./outcome-schema.js";

function snap(
  o: Partial<PerformanceOutcome> & { metricDate: string; metrics: OutcomeMetrics },
): PerformanceOutcome {
  return {
    contentId: null,
    platform: "douyin",
    platformTitle: "作品甲",
    publishedAt: null,
    source: "auto",
    recordedAt: "2026-08-23T00:00:00.000Z",
    needsReview: false,
    reviewReasons: [],
    ...o,
  };
}

const FROM = "2026-08-16";
const TO = "2026-08-23";

describe("deltaInWindow", () => {
  it("窗口前快照做基线:增量 = 窗口末快照 − 基线快照", () => {
    const outcomes = [
      snap({ publishedAt: "2026-07-01T00:00:00.000Z", metricDate: "2026-08-14", metrics: { views: 1000, likes: 50 } }),
      snap({ publishedAt: "2026-07-01T00:00:00.000Z", metricDate: "2026-08-18", metrics: { views: 1200, likes: 60 } }),
      snap({ publishedAt: "2026-07-01T00:00:00.000Z", metricDate: "2026-08-20", metrics: { views: 1500, likes: 80 } }),
    ];
    const r = deltaInWindow(outcomes, FROM, TO);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      basis: "prior_snapshot",
      baseDate: "2026-08-14",
      toDate: "2026-08-20",
      delta: { views: 500, likes: 30 },
    });
  });

  it("老作品的累计值不许算成本期:基线过期 → 只做窗口内首尾差分", () => {
    // 6 月抓过一次,本周重抓——按 metricDate 切窗会把 5000 播放全算成本周(codex #3 的 bug)
    const outcomes = [
      snap({ publishedAt: "2026-05-01T00:00:00.000Z", metricDate: "2026-06-01", metrics: { views: 1000 } }),
      snap({ publishedAt: "2026-05-01T00:00:00.000Z", metricDate: "2026-08-17", metrics: { views: 5000 } }),
      snap({ publishedAt: "2026-05-01T00:00:00.000Z", metricDate: "2026-08-20", metrics: { views: 5200 } }),
    ];
    const r = deltaInWindow(outcomes, FROM, TO);
    expect(r.items[0].basis).toBe("in_window_span");
    expect(r.items[0].delta.views).toBe(200); // 不是 5200,也不是 4200
  });

  it("快照有缺口且窗口内只有一条:不插值,进 noBaseline 不进小计", () => {
    const outcomes = [
      snap({ publishedAt: "2026-05-01T00:00:00.000Z", metricDate: "2026-06-01", metrics: { views: 1000 } }),
      snap({ publishedAt: "2026-05-01T00:00:00.000Z", metricDate: "2026-08-20", metrics: { views: 9000 } }),
    ];
    const r = deltaInWindow(outcomes, FROM, TO);
    expect(r.items).toHaveLength(0);
    expect(r.noBaseline).toHaveLength(1);
    expect(r.noBaseline[0].reason).toContain("宽限期");
    expect(r.byPlatform).toHaveLength(0);
  });

  it("本窗口内发布:累计值即增量,基线是真零", () => {
    const outcomes = [
      snap({ publishedAt: "2026-08-18T00:00:00.000Z", metricDate: "2026-08-20", metrics: { views: 3000, likes: 90, comments: 10, shares: 20 } }),
    ];
    const r = deltaInWindow(outcomes, FROM, TO);
    expect(r.items[0]).toMatchObject({ basis: "published_in_window", baseDate: null, delta: { views: 3000 } });
    // 互动率 =(90+10+20)/3000 = 4%
    expect(r.items[0].rates.engagementRate).toBeCloseTo(4, 5);
  });

  it("负增量(平台修数)夹到 0,rawDelta 保留原值并点名被夹的指标", () => {
    const outcomes = [
      snap({ publishedAt: "2026-07-01T00:00:00.000Z", metricDate: "2026-08-14", metrics: { views: 1000, likes: 50 } }),
      snap({ publishedAt: "2026-07-01T00:00:00.000Z", metricDate: "2026-08-20", metrics: { views: 900, likes: 60 } }),
    ];
    const r = deltaInWindow(outcomes, FROM, TO);
    expect(r.items[0].delta).toMatchObject({ views: 0, likes: 10 });
    expect(r.items[0].rawDelta.views).toBe(-100);
    expect(r.items[0].clamped).toEqual(["views"]);
    expect(r.byPlatform[0].totals.views).toBe(0); // 小计吃的是夹过的值,不会被负数抵扣
  });

  it("跨平台:绝对量只按平台分列,曝光与播放各占各的字段", () => {
    const outcomes = [
      snap({ platformTitle: "抖音稿", publishedAt: "2026-08-18T00:00:00.000Z", metricDate: "2026-08-20", metrics: { views: 1000, impressions: 8000 } }),
      snap({ platform: "xiaohongshu", platformTitle: "小红书稿", publishedAt: "2026-08-18T00:00:00.000Z", metricDate: "2026-08-20", metrics: { views: 200, impressions: 3000 } }),
    ];
    const r = deltaInWindow(outcomes, FROM, TO);
    const platforms = r.byPlatform.map((p) => p.platform).sort();
    expect(platforms).toEqual(["douyin", "xiaohongshu"]);
    const douyin = r.byPlatform.find((p) => p.platform === "douyin");
    expect(douyin?.totals).toMatchObject({ views: 1000, impressions: 8000 });
    // 结构上没有全局合计这一层:跨平台绝对量在类型里就无处可放
    expect(r).not.toHaveProperty("totals");
    expect(r.items.every((i) => typeof i.platform === "string")).toBe(true);
  });

  it("窗口内没有任何快照的作品:既不进 items 也不进 noBaseline(没数据 ≠ 0 增长)", () => {
    const outcomes = [
      snap({ publishedAt: "2026-05-01T00:00:00.000Z", metricDate: "2026-06-01", metrics: { views: 1000 } }),
      snap({ publishedAt: "2026-05-01T00:00:00.000Z", metricDate: "2026-06-08", metrics: { views: 1200 } }),
    ];
    const r = deltaInWindow(outcomes, FROM, TO);
    expect(r.items).toHaveLength(0);
    expect(r.noBaseline).toHaveLength(0);
  });

  it("基线缺某个指标时该指标整项跳过,不拿 0 当基线", () => {
    const outcomes = [
      snap({ publishedAt: "2026-07-01T00:00:00.000Z", metricDate: "2026-08-14", metrics: { views: 1000 } }),
      snap({ publishedAt: "2026-07-01T00:00:00.000Z", metricDate: "2026-08-20", metrics: { views: 1500, favorites: 300 } }),
    ];
    const r = deltaInWindow(outcomes, FROM, TO);
    expect(r.items[0].delta.views).toBe(500);
    expect(r.items[0].delta.favorites).toBeUndefined(); // 不报 +300
  });
});

describe("publishCohort", () => {
  const contents = [
    { id: "c1", title: "本期发布甲", platform: "douyin", publishedAt: "2026-08-17T02:00:00.000Z" },
    { id: "c2", title: "本期发布乙", platform: "xiaohongshu", publishedAt: "2026-08-18T02:00:00.000Z" },
    { id: "c3", title: "上期发布丙", platform: "douyin", publishedAt: "2026-07-01T02:00:00.000Z" },
  ];
  const outcomes = [
    snap({ contentId: "c1", platformTitle: "本期发布甲", publishedAt: "2026-08-17T02:00:00.000Z", metricDate: "2026-08-19", metrics: { views: 800 } }),
    snap({ contentId: "c1", platformTitle: "本期发布甲", publishedAt: "2026-08-17T02:00:00.000Z", metricDate: "2026-08-22", metrics: { views: 2000, likes: 100, comments: 20, shares: 30, completionRate: 33 } }),
    snap({ contentId: "c3", platform: "douyin", platformTitle: "上期发布丙", publishedAt: "2026-07-01T02:00:00.000Z", metricDate: "2026-08-22", metrics: { views: 99999 } }),
  ];

  it("只收窗口内发布的稿,累计值取最新快照并带发布龄期", () => {
    const r = publishCohort(contents, outcomes, FROM, TO);
    expect(r.items.map((i) => i.contentId).sort()).toEqual(["c1", "c2"]); // c3 上期发布,不进 cohort
    const c1 = r.items.find((i) => i.contentId === "c1");
    expect(c1).toMatchObject({ snapshotCount: 2, latestMetricDate: "2026-08-22", ageDays: 5 });
    expect(c1?.cumulative?.views).toBe(2000);
    expect(c1?.rates.completionRate).toBe(33);
    expect(c1?.rates.engagementRate).toBeCloseTo(7.5, 5); // (100+20+30)/2000
  });

  it("发布了但零快照:累计值 null 且计入 missingData(不是表现为 0)", () => {
    const r = publishCohort(contents, outcomes, FROM, TO);
    const c2 = r.items.find((i) => i.contentId === "c2");
    expect(c2?.cumulative).toBeNull();
    expect(c2?.ageDays).toBeNull();
    expect(r.missingData).toBe(1);
  });

  it("小计按平台分列,withData 与 works 分开计数", () => {
    const r = publishCohort(contents, outcomes, FROM, TO);
    expect(r.byPlatform.find((p) => p.platform === "douyin")).toMatchObject({ works: 1, withData: 1, totals: { views: 2000 } });
    expect(r.byPlatform.find((p) => p.platform === "xiaohongshu")).toMatchObject({ works: 1, withData: 0, totals: {} });
  });
});

describe("metricsAtAge", () => {
  const pub = "2026-08-01T02:00:00.000Z";
  const snaps = [
    snap({ metricDate: "2026-08-03", metrics: { views: 100 } }),
    snap({ metricDate: "2026-08-10", metrics: { views: 700, likes: 35 } }),
    snap({ metricDate: "2026-08-20", metrics: { views: 900 } }),
  ];

  it("取龄期 ≥N 天的首个快照(不是最近一条)", () => {
    const at = metricsAtAge(snaps, pub, 7);
    expect(at).toMatchObject({ metricDate: "2026-08-10", ageDays: 9 });
    expect(at?.metrics.views).toBe(700);
    expect(at?.rates.engagementRate).toBeCloseTo(5, 5);
  });

  it("没有到龄快照 → null(不拿最近一条冒充 D+7)", () => {
    expect(metricsAtAge([snaps[0]], pub, 7)).toBeNull();
  });

  it("无发布时间 → null(算不出龄期就不给读数)", () => {
    expect(metricsAtAge(snaps, null, 7)).toBeNull();
  });

  it("metricsAtAgeAll 按作品分组给全账号定龄读数,缺发布时间的作品被跳过", () => {
    const outcomes = [
      snap({ contentId: "a", platformTitle: "甲", publishedAt: pub, metricDate: "2026-08-10", metrics: { views: 700 } }),
      snap({ contentId: "b", platformTitle: "乙", publishedAt: pub, metricDate: "2026-08-12", metrics: { views: 300 } }),
      snap({ contentId: "c", platformTitle: "丙", publishedAt: null, metricDate: "2026-08-12", metrics: { views: 5 } }),
    ];
    const all = metricsAtAgeAll(outcomes, 7);
    expect(all.map((e) => e.contentId).sort()).toEqual(["a", "b"]);
    expect(all.every((e) => e.at.ageDays >= 7)).toBe(true);
  });
});

describe("小工具", () => {
  it("groupByEntity 按作品聚快照并按数据日期升序", () => {
    const groups = groupByEntity([
      snap({ contentId: "a", metricDate: "2026-08-20", metrics: { views: 2 } }),
      snap({ contentId: "a", metricDate: "2026-08-10", metrics: { views: 1 } }),
      snap({ contentId: "b", platformTitle: "另一篇", metricDate: "2026-08-10", metrics: { views: 3 } }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].snapshots.map((s) => s.metricDate)).toEqual(["2026-08-10", "2026-08-20"]);
  });

  it("播放为 0 或缺失时不给互动率(除以 0 是编数据)", () => {
    expect(computeRates({ views: 0, likes: 10 }).engagementRate).toBeUndefined();
    expect(computeRates({ likes: 10 }).engagementRate).toBeUndefined();
  });

  it("median 空样本给 null;ageInDays 按整天算", () => {
    expect(median([])).toBeNull();
    expect(median([1, 3, 2])).toBe(2);
    expect(ageInDays("2026-08-01T23:00:00.000Z", "2026-08-08")).toBe(7);
  });
});
