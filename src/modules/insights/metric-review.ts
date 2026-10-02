/**
 * 指标级复核口径（选题会 spec §5.1/§5.3）。
 *
 * 旧口径按 needsReview 整行剔除：一个可疑的完播率会连带丢掉同一行有效的播放和 5 秒完播。
 * 现在把复核理由落到具体指标上，只剔那几个指标；认不出是哪个指标的理由，仍整行剔除（宁缺不错）。
 *
 * 另外一张「可回流指标表」：自动回流在各平台实际映射了哪些指标（以适配器代码为准），
 * 下注的 watch.metric 只能从表里选；将来有量纲没核过的指标就在表里标 unverified（「未核」），只能参考。
 */
import { normalizePlatform, type OutcomeMetrics, type PerformanceOutcome } from "../flywheel/outcome-schema.js";
import type { MetricFocus } from "../retro/hypotheses.js";

export interface PullableMetric { metric: MetricFocus; label: string; unverified?: true }

/**
 * 抖音：douyin-stats.ts mapItem；原始返回（item/list 与旧路 work_list，含 fixtures 与端点文档）
 * 里没有单作品涨粉字段，所以 follows 不进表。完播率是百分比（2026-10-02 后台截图核过：长视频 0.63% 是真值）。
 * 小红书：xhs-stats.ts；视频号：wechat-video-stats.ts mapPostRow。
 */
export const PULLABLE_METRICS: Record<string, PullableMetric[]> = {
  douyin: [
    { metric: "views", label: "播放" }, { metric: "likes", label: "赞" }, { metric: "comments", label: "评" },
    { metric: "shares", label: "转" }, { metric: "favorites", label: "藏" },
    { metric: "completionRate", label: "完播率" }, { metric: "completion5s", label: "5秒完播率" },
  ],
  xiaohongshu: [
    { metric: "views", label: "播放" }, { metric: "likes", label: "赞" }, { metric: "favorites", label: "藏" },
    { metric: "comments", label: "评" },
  ],
  wechat_video: [
    { metric: "views", label: "播放" }, { metric: "likes", label: "赞" }, { metric: "comments", label: "评" },
    { metric: "shares", label: "转" }, { metric: "favorites", label: "藏" }, { metric: "follows", label: "涨粉" },
    { metric: "completionRate", label: "完播率" },
  ],
};

export function pullableMetric(platform: string, metric: string): PullableMetric | null {
  return PULLABLE_METRICS[normalizePlatform(platform)]?.find((m) => m.metric === metric) ?? null;
}

export function isUnverified(platform: string, metric: string): boolean {
  return pullableMetric(platform, metric)?.unverified === true;
}

/** 复核理由 → 它说的是哪个指标；null = 不是指标问题（如绑定分歧），undefined = 认不出 */
function reasonMetric(reason: string, platform: string): keyof OutcomeMetrics | null | undefined {
  if (reason.startsWith("5s完播率")) return "completion5s";
  // 旧规则给抖音完播率 <1% 打的复核标记是误报（长视频真值，2026-10-02 后台截图核过）：存量行不再因此剔除
  if (reason.startsWith("完播率") && reason.includes("低于 1%") && normalizePlatform(platform) === "douyin") return null;
  if (reason.startsWith("完播率")) return "completionRate";
  if (reason.startsWith("封面点击率")) return "coverClickRate";
  if (reason.startsWith("播放为 0 但有互动") || reason.startsWith("播放量 ")) return "views";
  if (reason.startsWith("平台作品 ") && reason.includes("已绑定稿件")) return null;
  return undefined;
}

/**
 * 去掉被复核理由点名的指标后的行；有认不出的理由 → null（整行不进统计）。
 * 不改 needsReview/reviewReasons 本身——那是给人看的原始标记。
 */
export function reviewedRow(row: PerformanceOutcome): PerformanceOutcome | null {
  if (!row.needsReview) return row;
  if (!(row.reviewReasons ?? []).length) return null;
  const metrics: OutcomeMetrics = { ...row.metrics };
  for (const reason of row.reviewReasons ?? []) {
    const key = reasonMetric(reason, row.platform);
    if (key === undefined) return null;
    if (key) delete metrics[key];
  }
  return Object.values(metrics).some((v) => typeof v === "number") ? { ...row, metrics } : null;
}
