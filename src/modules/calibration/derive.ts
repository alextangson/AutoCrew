/**
 * 由状态派生的两张表（state-management.md「单一真值」）：
 * - Confidence 只由 calibration_samples 决定，只用来**显示**，不拿来卡任何功能；
 * - bucket 边界：有本平台基线（中位数）→ 基线 × {0.3, 1, 3, 10} 切 5 档；没有 → 平台通用默认。
 *   基线来源：校准池样本 ≥10 → 用校准池自己的中位数重算；否则用同平台 D+3 同龄读数的中位数。
 */
import { median, metricsNearAgeAll, groupByEntity } from "../flywheel/metrics-window.js";
import { normalizePlatform, type PerformanceOutcome } from "../flywheel/outcome-schema.js";
import { reviewedRow } from "../insights/metric-review.js";
import { BASELINE_RECALC_SAMPLES, RETRO_WINDOW_DAYS } from "./constants.js";
import type { BaselineEntry } from "./store.js";

export interface ConfidenceLabel { level: string; label: string; meaning: string }

const CONFIDENCE_TABLE: Array<[number, ConfidenceLabel]> = [
  [0, { level: "red", label: "🔴 极低", meaning: "占星级别，纯纪律训练：写预测是为了采集数据，不是做决策" }],
  [2, { level: "orange", label: "🟠 低", meaning: "中枢 ±50%，方向感优于绝对数字" }],
  [5, { level: "yellow", label: "🟡 偏低", meaning: "中枢 ±40%，可作为参考之一" }],
  [10, { level: "green", label: "🟢 中", meaning: "中枢 ±25%，可参与决策" }],
  [20, { level: "green+", label: "🟢 较高", meaning: "中枢 ±15%，评分表形态稳定" }],
];
const TOP: ConfidenceLabel = { level: "blue", label: "🔵 高", meaning: "中枢 ±10%，可数据驱动升级" };

export function confidenceFor(samples: number): ConfidenceLabel {
  for (const [max, label] of CONFIDENCE_TABLE) if (samples <= max) return label;
  return TOP;
}

export interface Bucket { name: string; min: number; max: number | null }
export interface BucketScheme { scheme: "ratio" | "platform_default"; baseline: BaselineEntry | null; buckets: Bucket[] }

const RATIOS = [0.3, 1, 3, 10];
const RATIO_NAMES = ["退步", "持平", "命中", "小爆", "大爆"];
/** 0 粉新人第 1 条的平台通用默认（opinion-video-zero.md） */
const DEFAULT_EDGES = [100, 1_000, 10_000, 100_000];
const DEFAULT_NAMES = ["底部", "基础盘", "命中", "小爆", "大爆"];

function cut(edges: number[], names: string[]): Bucket[] {
  return names.map((name, i) => ({ name, min: i === 0 ? 0 : edges[i - 1], max: i < edges.length ? edges[i] : null }));
}

export function deriveBuckets(baseline: BaselineEntry | null): BucketScheme {
  if (!baseline || !(baseline.plays > 0)) return { scheme: "platform_default", baseline: null, buckets: cut(DEFAULT_EDGES, DEFAULT_NAMES) };
  const edges = RATIOS.map((r) => Math.round(baseline.plays * r));
  return { scheme: "ratio", baseline, buckets: cut(edges, RATIO_NAMES) };
}

export function bucketOf(views: number, buckets: Bucket[]): Bucket {
  return buckets.find((b) => views >= b.min && (b.max === null || views < b.max)) ?? buckets[buckets.length - 1];
}

/**
 * 基线：校准池（本平台）≥10 条 → 池中位数；否则同平台 D+3 同龄读数（剔待复核指标）最近 10 条的中位数；都没有 → null。
 */
export function deriveBaseline(platform: string, outcomes: PerformanceOutcome[], poolViews: number[], now = new Date()): BaselineEntry | null {
  const at = now.toISOString();
  if (poolViews.length >= BASELINE_RECALC_SAMPLES) {
    return { plays: median(poolViews) ?? 0, source: "calibration_pool", n: poolViews.length, computed_at: at };
  }
  const p = normalizePlatform(platform);
  const rows = outcomes.map(reviewedRow).filter((r): r is PerformanceOutcome => r !== null && normalizePlatform(r.platform) === p);
  const cohort = metricsNearAgeAll(groupByEntity(rows), RETRO_WINDOW_DAYS)
    .filter((e) => typeof e.at.metrics.views === "number")
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)).slice(0, 10)
    .map((e) => e.at.metrics.views as number);
  const m = median(cohort);
  return m && m > 0 ? { plays: m, source: "age_cohort_d3", n: cohort.length, computed_at: at } : null;
}
