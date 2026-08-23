/**
 * hypothesis-judge.test.ts —— 假设裁决(spec §5.3):**确定性代码,不经模型**。
 * 四种裁决 + 边界(对照样本恰 5、相对差恰 20%)+ 拒判理由如实。
 */
import { describe, it, expect } from "vitest";
import {
  judgeHypothesis,
  buildAgeBaseline,
  applyJudgement,
  MIN_BASELINE_SAMPLE,
  REL_DIFF_THRESHOLD,
  JUDGE_AGE_DAYS,
} from "./hypothesis-judge.js";
import type { Hypothesis, MetricFocus } from "./hypotheses.js";
import { computeRates, type AgeCohortEntry } from "../flywheel/metrics-window.js";
import type { OutcomeMetrics } from "../flywheel/outcome-schema.js";

function entry(contentId: string, platform: string, metrics: OutcomeMetrics): AgeCohortEntry {
  return {
    entityKey: `${platform}:${contentId}:`,
    platform,
    contentId,
    title: `稿件 ${contentId}`,
    publishedAt: "2026-08-01T02:00:00.000Z",
    at: { metricDate: "2026-08-08", ageDays: 7, metrics, rates: computeRates(metrics) },
  };
}

/** N 篇同平台对照稿,指标值相同 → 中位数 = value */
function peers(n: number, platform: string, metrics: OutcomeMetrics): AgeCohortEntry[] {
  return Array.from({ length: n }, (_, i) => entry(`peer${i}`, platform, metrics));
}

function hypothesis(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: "hyp-1",
    statement: "开头 5s 抛问题的视频播放高于账号基线",
    metricFocus: "views" as MetricFocus,
    direction: "up",
    scope: { platform: "douyin" },
    contentIds: ["t1"],
    proposedAt: "2026-08-01T00:00:00.000Z",
    retroRunId: "retro-weekly-2026-08-01T090000",
    status: "open",
    ...over,
  };
}

describe("judgeHypothesis 四种裁决", () => {
  it("supported:方向一致且相对差恰好 20%(边界取到)", () => {
    const aggregates = [...peers(5, "douyin", { views: 100 }), entry("t1", "douyin", { views: 120 })];
    const v = judgeHypothesis(hypothesis(), { aggregates });
    expect(v.status).toBe("supported");
    expect(v.evidence).toMatchObject({
      sampleSize: 1,
      baselineSampleSize: MIN_BASELINE_SAMPLE,
      testValue: 120,
      baselineValue: 100,
      ageDays: JUDGE_AGE_DAYS,
    });
    expect(v.evidence.relDiff).toBeCloseTo(REL_DIFF_THRESHOLD, 10);
    expect(v.evidence.note).toContain("观察性结论");
  });

  it("supported:相对差恰 20% 但浮点算出 0.19999…,不许被浮点吃掉", () => {
    const aggregates = [
      ...peers(5, "douyin", { completionRate: 4 }),
      entry("t1", "douyin", { completionRate: 4.8 }),
    ];
    expect((4.8 - 4) / 4).toBeLessThan(REL_DIFF_THRESHOLD); // 自校验:确实是那个恶心的浮点
    expect(judgeHypothesis(hypothesis({ metricFocus: "completionRate" }), { aggregates }).status).toBe("supported");
  });

  it("refuted:反向且相对差 ≥20%", () => {
    const aggregates = [...peers(5, "douyin", { views: 100 }), entry("t1", "douyin", { views: 80 })];
    const v = judgeHypothesis(hypothesis(), { aggregates });
    expect(v.status).toBe("refuted");
    expect(v.evidence.relDiff).toBeCloseTo(-0.2, 10);
  });

  it("direction=down:低于基线 20% 才叫成立", () => {
    const aggregates = [...peers(5, "douyin", { views: 100 }), entry("t1", "douyin", { views: 80 })];
    expect(judgeHypothesis(hypothesis({ direction: "down" }), { aggregates }).status).toBe("supported");
  });

  it("inconclusive:差不够阈值(19% 不算数)", () => {
    const aggregates = [...peers(5, "douyin", { views: 100 }), entry("t1", "douyin", { views: 119 })];
    const v = judgeHypothesis(hypothesis(), { aggregates });
    expect(v.status).toBe("inconclusive");
    expect(v.evidence.reason).toContain("未达");
  });

  it("inconclusive:对照样本 4 篇 < 5(边界的另一侧)", () => {
    const aggregates = [...peers(4, "douyin", { views: 100 }), entry("t1", "douyin", { views: 500 })];
    const v = judgeHypothesis(hypothesis(), { aggregates });
    expect(v.status).toBe("inconclusive");
    expect(v.evidence.baselineSampleSize).toBe(4);
    expect(v.evidence.reason).toContain("对照样本");
  });

  it("inconclusive:绑定稿件还没到龄(D+7 读数不存在)", () => {
    const v = judgeHypothesis(hypothesis(), { aggregates: peers(9, "douyin", { views: 100 }) });
    expect(v.status).toBe("inconclusive");
    expect(v.evidence.sampleSize).toBe(0);
    expect(v.evidence.reason).toContain("定龄读数");
  });

  it("inconclusive:假设没绑任何试验稿", () => {
    const v = judgeHypothesis(hypothesis({ contentIds: [] }), { aggregates: peers(9, "douyin", { views: 100 }) });
    expect(v.status).toBe("inconclusive");
    expect(v.evidence.reason).toContain("未绑定");
  });

  it("inconclusive:基线中位数为 0,相对差无意义", () => {
    const aggregates = [...peers(5, "douyin", { views: 0 }), entry("t1", "douyin", { views: 500 })];
    const v = judgeHypothesis(hypothesis(), { aggregates });
    expect(v.status).toBe("inconclusive");
    expect(v.evidence.reason).toContain("基线中位数为 0");
  });
});

describe("跨平台纪律(spec §5.2)", () => {
  it("绝对量跨平台 → 拒判,并提示把 scope 收到单平台", () => {
    const aggregates = [
      ...peers(5, "douyin", { views: 100 }),
      entry("t1", "douyin", { views: 500 }),
      entry("t2", "xiaohongshu", { views: 400 }),
    ];
    const v = judgeHypothesis(hypothesis({ scope: {}, contentIds: ["t1", "t2"] }), { aggregates });
    expect(v.status).toBe("inconclusive");
    expect(v.evidence.reason).toContain("不可跨平台");
    expect(v.evidence.platforms).toEqual(["douyin", "xiaohongshu"]);
  });

  it("率类(完播率)可以跨平台判", () => {
    const aggregates = [
      ...peers(3, "douyin", { completionRate: 40 }),
      ...peers(2, "xiaohongshu", { completionRate: 40 }).map((e) => ({ ...e, contentId: `x${e.contentId}` })),
      entry("t1", "douyin", { completionRate: 60 }),
      entry("t2", "xiaohongshu", { completionRate: 60 }),
    ];
    const v = judgeHypothesis(
      hypothesis({ metricFocus: "completionRate", scope: {}, contentIds: ["t1", "t2"] }),
      { aggregates },
    );
    expect(v.status).toBe("supported");
    expect(v.evidence.baselineSampleSize).toBe(5);
  });
});

describe("基线构造", () => {
  it("剔除假设自己的试验稿:试验稿不给自己当对照", () => {
    const aggregates = [...peers(5, "douyin", { views: 100 }), entry("t1", "douyin", { views: 9999 })];
    const base = buildAgeBaseline(aggregates, { platforms: ["douyin"], metric: "views", excludeContentIds: ["t1"] });
    expect(base).toMatchObject({ median: 100, sampleSize: 5 });
  });

  it("外部注入的基线优先于现算", () => {
    const aggregates = [entry("t1", "douyin", { views: 120 })];
    const v = judgeHypothesis(hypothesis(), { aggregates, baseline: { median: 100, sampleSize: 8 } });
    expect(v.status).toBe("supported");
    expect(v.evidence.baselineSampleSize).toBe(8);
  });
});

describe("applyJudgement", () => {
  it("inconclusive 不闭合假设:留在 open,只更新证据,等下期再判", () => {
    const h = hypothesis();
    const updated = applyJudgement(h, {
      status: "inconclusive",
      evidence: judgeHypothesis(h, { aggregates: [] }).evidence,
    });
    expect(updated.status).toBe("open");
    expect(updated.verdictAt).toBeUndefined();
    expect(updated.evidence?.reason).toBeTruthy();
  });

  it("supported/refuted 盖终裁并留时间戳", () => {
    const aggregates = [...peers(5, "douyin", { views: 100 }), entry("t1", "douyin", { views: 200 })];
    const verdict = judgeHypothesis(hypothesis(), { aggregates });
    const updated = applyJudgement(hypothesis(), verdict, "2026-08-23T10:00:00.000Z");
    expect(updated).toMatchObject({ status: "supported", verdictAt: "2026-08-23T10:00:00.000Z" });
    expect(updated.evidence?.testValue).toBe(200);
  });
});
