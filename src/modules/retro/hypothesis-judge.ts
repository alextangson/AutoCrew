/**
 * 假设裁决 —— **确定性代码，不是 prompt**（spec §5.3，codex #7/#8）。
 *
 * 口径：假设绑定稿件的 D+7 定龄指标（中位）vs 同平台账号基线（同龄期中位数，剔除绑定稿件自己）。
 *   - 对照样本 <5 或绑定稿件没有到龄读数 → inconclusive；
 *   - 相对差 ≥20% 且方向一致 → supported；≥20% 反向 → refuted；其间 → inconclusive。
 *
 * 裁决结论**只是观察性结论**：题材/时长/发布时段/投流等混杂因素一个都没隔离，
 * 不是对照实验，更不是因果。这句话跟着 evidence.note 一路进报告，模型不得改写裁决。
 *
 * 「样本 <5」落在**对照基线**上：绑定稿件通常只有一两篇试验稿，要求试验侧也 ≥5
 * 会让任何假设永远 inconclusive；而中位数基线低于 5 个样本本就没有意义。
 * 绑定侧的门槛是「至少 1 篇拿到 D+7 读数」，否则理由如实写「龄期不足/尚无回流」。
 */
import type { AgeCohortEntry } from "../flywheel/metrics-window.js";
import { median, readMetric } from "../flywheel/metrics-window.js";
import { COUNTER_METRICS } from "../flywheel/metrics-window.js";
import type { Hypothesis, HypothesisEvidence, HypothesisStatus, MetricFocus } from "./hypotheses.js";

/** 定龄口径：D+7 */
export const JUDGE_AGE_DAYS = 7;
/** 对照基线最少样本数 */
export const MIN_BASELINE_SAMPLE = 5;
/** 相对差阈值：20% */
export const REL_DIFF_THRESHOLD = 0.2;
/** 浮点容差：3 → 3.6 的相对差算出来是 0.19999999999999998，边界不该被浮点吃掉 */
const EPS = 1e-9;

export const OBSERVATIONAL_NOTE =
  "观察性结论,非对照实验,混杂因素(题材/时长/发布时段/投流)未隔离";

export interface JudgeVerdict {
  status: HypothesisStatus;
  evidence: HypothesisEvidence;
}

export interface BaselineStat {
  median: number | null;
  sampleSize: number;
}

export interface JudgeContext {
  /** 全账号 D+N 定龄读数（metricsAtAgeAll 算好的） */
  aggregates: AgeCohortEntry[];
  /** 对照基线；不传则从 aggregates 现算（同平台、同龄期、剔除假设自己的稿件） */
  baseline?: BaselineStat;
  ageDays?: number;
}

function isCounterMetric(metric: MetricFocus): boolean {
  return (COUNTER_METRICS as readonly string[]).includes(metric);
}

/** 同平台账号基线：同龄期读数的中位数，剔除 excludeContentIds（试验稿不能给自己当对照） */
export function buildAgeBaseline(
  aggregates: AgeCohortEntry[],
  opts: { platforms: string[]; metric: MetricFocus; excludeContentIds?: string[] },
): BaselineStat {
  const exclude = new Set(opts.excludeContentIds ?? []);
  const values = aggregates
    .filter((e) => opts.platforms.includes(e.platform))
    .filter((e) => !(e.contentId && exclude.has(e.contentId)))
    .flatMap((e) => {
      const v = readMetric(e.at, opts.metric);
      return typeof v === "number" ? [v] : [];
    });
  return { median: median(values), sampleSize: values.length };
}

function evidenceOf(
  h: Hypothesis,
  ageDays: number,
  platforms: string[],
  parts: Partial<HypothesisEvidence>,
): HypothesisEvidence {
  return {
    metricFocus: h.metricFocus,
    ageDays,
    platforms,
    sampleSize: 0,
    baselineSampleSize: 0,
    testValue: null,
    baselineValue: null,
    relDiff: null,
    reason: "",
    note: OBSERVATIONAL_NOTE,
    ...parts,
  };
}

/** 方向一致 → supported；反向 → refuted；差不够 → inconclusive */
function verdictFromDiff(direction: Hypothesis["direction"], relDiff: number): HypothesisStatus {
  const up = relDiff >= REL_DIFF_THRESHOLD - EPS;
  const down = relDiff <= -REL_DIFF_THRESHOLD + EPS;
  if (direction === "up") return up ? "supported" : down ? "refuted" : "inconclusive";
  return down ? "supported" : up ? "refuted" : "inconclusive";
}

type Preflight = { blocked: JudgeVerdict } | { testValues: number[]; platforms: string[] };

/** 取数前的三道拒判闸：没绑稿 / 没到龄 / 跨平台比绝对量。理由一律如实写进 evidence */
function preflight(h: Hypothesis, ctx: JudgeContext, ageDays: number): Preflight {
  const bound = new Set(h.contentIds);
  const scoped = ctx.aggregates.filter(
    (e) => (!h.scope.platform || e.platform === h.scope.platform) && e.contentId && bound.has(e.contentId),
  );
  const platforms = [...new Set(scoped.map((e) => e.platform))].sort();
  const block = (parts: Partial<HypothesisEvidence>): Preflight => ({
    blocked: { status: "inconclusive", evidence: evidenceOf(h, ageDays, platforms, parts) },
  });

  if (h.contentIds.length === 0) return block({ reason: "假设未绑定试验稿,无从取数" });
  const testValues = scoped.flatMap((e) => {
    const v = readMetric(e.at, h.metricFocus);
    return typeof v === "number" ? [v] : [];
  });
  if (testValues.length === 0) {
    return block({ reason: `绑定的 ${h.contentIds.length} 篇稿件尚无 D+${ageDays} 定龄读数(龄期不足或数据未回流)` });
  }
  // 跨平台纪律(spec §5.2):绝对量不跨平台比,率类才可以
  if (platforms.length > 1 && isCounterMetric(h.metricFocus)) {
    return block({
      sampleSize: testValues.length,
      reason: `绑定稿件跨 ${platforms.length} 个平台,绝对量指标不可跨平台比较(spec §5.2),请把假设 scope 收到单平台`,
    });
  }
  return { testValues, platforms };
}

/**
 * 裁一条假设。**全部输入都是代码算好的聚合，模型碰不到这里。**
 * 任何拒判都给出如实理由（样本不足/龄期不足/跨平台不可比/基线为 0），不静默给结论。
 */
export function judgeHypothesis(h: Hypothesis, ctx: JudgeContext): JudgeVerdict {
  const ageDays = ctx.ageDays ?? JUDGE_AGE_DAYS;
  const pre = preflight(h, ctx, ageDays);
  if ("blocked" in pre) return pre.blocked;
  const { testValues, platforms } = pre;

  const baseline =
    ctx.baseline ??
    buildAgeBaseline(ctx.aggregates, {
      platforms: platforms.length > 0 ? platforms : h.scope.platform ? [h.scope.platform] : [],
      metric: h.metricFocus,
      excludeContentIds: h.contentIds,
    });
  const testValue = median(testValues) as number;
  const base = evidenceOf(h, ageDays, platforms, {
    sampleSize: testValues.length,
    baselineSampleSize: baseline.sampleSize,
    testValue,
    baselineValue: baseline.median,
  });

  if (baseline.sampleSize < MIN_BASELINE_SAMPLE) {
    return {
      status: "inconclusive",
      evidence: { ...base, reason: `对照样本 ${baseline.sampleSize} 篇 < ${MIN_BASELINE_SAMPLE} 篇,不足以定基线` },
    };
  }
  if (baseline.median === null || baseline.median === 0) {
    return { status: "inconclusive", evidence: { ...base, reason: "基线中位数为 0 或缺失,相对差无意义" } };
  }

  const relDiff = (testValue - baseline.median) / baseline.median;
  const status = verdictFromDiff(h.direction, relDiff);
  const pct = `${(relDiff * 100).toFixed(1)}%`;
  const reason =
    status === "inconclusive"
      ? `相对差 ${pct},未达 ±${REL_DIFF_THRESHOLD * 100}% 阈值`
      : `试验中位 ${testValue} vs 基线中位 ${baseline.median}(${baseline.sampleSize} 篇),相对差 ${pct}`;
  return { status, evidence: { ...base, relDiff, reason } };
}

/**
 * 把裁决盖回假设记录（append-only：调用方 append 新版本，旧版本留在 journal 可回溯）。
 * **inconclusive 不闭合假设**——「还判不出来」不是结论,记下最新证据但保持 open,
 * 下期数据够了再判;闭合了它就再也不会被复盘捡起来。
 */
export function applyJudgement(h: Hypothesis, verdict: JudgeVerdict, at?: string): Hypothesis {
  if (verdict.status === "inconclusive") return { ...h, evidence: verdict.evidence };
  return { ...h, status: verdict.status, evidence: verdict.evidence, verdictAt: at ?? new Date().toISOString() };
}
