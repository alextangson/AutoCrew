/**
 * Outcome Schema — draft↔outcome 带标签数据集的核心 schema（PRD v3 §3 第一公民交付物）。
 *
 * 一条 PerformanceOutcome = 某平台上某条作品在某个数据日期的表现快照。
 * verify 规则（PRD §6）：值域/日期校验不过 = 拒收；可疑值收下但标 needsReview 转人工。
 */

export interface OutcomeMetrics {
  views?: number;
  /** 完播率，百分比 0-100 */
  completionRate?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  favorites?: number;
  follows?: number;
}

export type OutcomeSource = "csv" | "paste" | "auto";

export interface PerformanceOutcome {
  /** AutoCrew content id；历史回灌（AutoCrew 诞生前的作品）为 null */
  contentId: string | null;
  platform: string;
  /** 平台上显示的标题（匹配与审计用） */
  platformTitle: string;
  /** 平台发布时间 ISO；历史导入可能缺失 */
  publishedAt: string | null;
  /** 本快照对应的数据日期 YYYY-MM-DD */
  metricDate: string;
  metrics: OutcomeMetrics;
  source: OutcomeSource;
  recordedAt: string;
  needsReview: boolean;
  reviewReasons: string[];
}

export interface OutcomeValidation {
  /** false = 拒收 */
  ok: boolean;
  needsReview: boolean;
  reasons: string[];
}

/** 口播赛道 reward signal（赛道包抽取后改从包读，接口保持此形状） */
export const KOUBO_REWARD = {
  primary: "completionRate",
  secondary: ["favorites", "follows"],
} as const satisfies { primary: keyof OutcomeMetrics; secondary: readonly (keyof OutcomeMetrics)[] };

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "");
}

export function validateOutcome(input: {
  metrics: OutcomeMetrics;
  publishedAt: string | null;
  metricDate: string;
}): OutcomeValidation {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.metricDate)) {
    return { ok: false, needsReview: false, reasons: [`数据日期 ${input.metricDate} 不是 YYYY-MM-DD 格式`] };
  }

  const reasons: string[] = [];
  const m = input.metrics;
  const values = Object.values(m).filter((v): v is number => typeof v === "number");

  if (values.length === 0) {
    return { ok: false, needsReview: false, reasons: ["没有任何指标值"] };
  }
  if (values.some((v) => !Number.isFinite(v))) {
    reasons.push("存在非有限数值（NaN/Infinity）");
  }
  const hasIllegalNegative = Object.entries(m).some(
    ([k, v]) => typeof v === "number" && v < 0 && k !== "follows",
  );
  if (hasIllegalNegative) {
    reasons.push("存在负数指标");
  }
  if (m.completionRate !== undefined && (m.completionRate < 0 || m.completionRate > 100)) {
    reasons.push(`完播率 ${m.completionRate} 超出 0-100`);
  }
  if (input.publishedAt) {
    const pubDate = input.publishedAt.slice(0, 10);
    if (input.metricDate < pubDate) {
      reasons.push(`数据日期 ${input.metricDate} 早于发布日期 ${pubDate}`);
    }
  }
  if (reasons.length > 0) {
    return { ok: false, needsReview: false, reasons };
  }

  // 可疑但不拒收 → needsReview 转人工
  const review: string[] = [];
  const engagement = (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.favorites || 0);
  if (m.views === 0 && engagement > 0) {
    review.push("播放为 0 但有互动，疑似读错字段");
  }
  if (m.completionRate !== undefined && m.completionRate > 0 && m.completionRate < 1) {
    review.push(`完播率 ${m.completionRate} 低于 1%，确认导出值不是小数比例（如 0.325 = 32.5%）`);
  }
  return { ok: true, needsReview: review.length > 0, reasons: review };
}

/** 幂等键：platform : (contentId 或 归一化标题@发布日期) : metricDate */
export function outcomeKey(o: {
  contentId: string | null;
  platform: string;
  platformTitle: string;
  publishedAt: string | null;
  metricDate: string;
}): string {
  const norm = normalizeTitle(o.platformTitle) || o.platformTitle;
  const item = o.contentId
    ? o.contentId
    : `${norm}@${o.publishedAt ? o.publishedAt.slice(0, 10) : "unknown"}`;
  return `${o.platform}:${item}:${o.metricDate}`;
}
