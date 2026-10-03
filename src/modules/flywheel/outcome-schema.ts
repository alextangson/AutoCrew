/**
 * Outcome Schema — draft↔outcome 带标签数据集的核心 schema（PRD v3 §3 第一公民交付物）。
 *
 * 一条 PerformanceOutcome = 某平台上某条作品在某个数据日期的表现快照。
 * verify 规则（PRD §6）：值域/日期校验不过 = 拒收；可疑值收下但标 needsReview 转人工。
 */

export interface OutcomeMetrics {
  views?: number;
  /** 曝光/展现量。与 views(播放)不是一个指标,任何展示与聚合都分列(codex #4) */
  impressions?: number;
  /** 完播率，百分比 0-100 */
  completionRate?: number;
  /** 5 秒完播率，百分比 0-100（抖音独有，对钩子质量更敏感） */
  completion5s?: number;
  /** 封面点击率，百分比 0-100：平台直接给的（抖音 metrics.cover_click_rate，09-27 真实接口核实）。
   *  有它就用它；没有时展示层才退回 播放 ÷ 曝光 推算 */
  coverClickRate?: number;
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
  /**
   * 平台作品 id(抖音 item_id / 视频号 objectId / xhs note_id)。
   * 只是**属性**——绑定与对账用,不进 outcomeKey:进了键就会与老行分叉成两条,
   * 同一作品被重复计数(codex #5)。
   */
  platformItemId?: string;
  metrics: OutcomeMetrics;
  source: OutcomeSource;
  recordedAt: string;
  needsReview: boolean;
  reviewReasons: string[];
  /**
   * 撤销标记（append-only 的「删除」）：删历史作品记录时给它名下的行追加一条同键 retracted 行，
   * latest-wins 后这一键就消失，原始未归属行重新露出来。journal 本身仍然不改写。
   */
  retracted?: true;
}

export interface OutcomeValidation {
  /** false = 拒收 */
  ok: boolean;
  needsReview: boolean;
  reasons: string[];
}

const RATE_METRICS = [
  ["completionRate", "完播率"],
  ["completion5s", "5s完播率"],
  ["coverClickRate", "封面点击率"],
] as const;

/**
 * 抖音完播率低于 1% 是真实值，不是量纲错（2026-10-02 创始人后台截图：6 分 14 秒长视频完播率 0.63%，
 * 同一条 5 秒完播 26.56%）——长视频的完播率天然很低，不再按「疑似小数比例」转人工。
 */
function subOneIsReal(platform: string | undefined, key: string): boolean {
  return key === "completionRate" && !!platform && normalizePlatform(platform) === "douyin";
}

/** 完播类指标检查：超出 0-100 拒收，(0,1) 疑似小数比例转人工（抖音完播率除外，见 subOneIsReal） */
function rateMetricIssues(m: OutcomeMetrics, platform?: string): { rejects: string[]; reviews: string[] } {
  const rejects: string[] = [];
  const reviews: string[] = [];
  for (const [key, label] of RATE_METRICS) {
    const v = m[key];
    if (v === undefined) continue;
    if (v < 0 || v > 100) rejects.push(`${label} ${v} 超出 0-100`);
    else if (v > 0 && v < 1 && !subOneIsReal(platform, key)) reviews.push(`${label} ${v} 低于 1%，确认导出值不是小数比例（如 0.325 = 32.5%）`);
  }
  return { rejects, reviews };
}

/** 其他工具接受的平台别名（如 "xhs"）；匹配/绑定/建键前统一归一，避免悄悄永不命中 */
const PLATFORM_ALIASES: Record<string, string> = { xhs: "xiaohongshu" };

export function normalizePlatform(platform: string): string {
  return PLATFORM_ALIASES[platform] ?? platform;
}

const SHANGHAI_OFFSET_MS = 8 * 3600_000;

/**
 * 发布时间 → Asia/Shanghai 日历日（YYYY-MM-DD）。回流的 publishedAt 是 UTC（pull-shared），
 * metricDate 是本地日期：直接截前 10 位，北京时间 0–8 点发的作品会差一天，
 * CSV 行与自动行也会分裂成两个作品。带时区（Z / ±hh:mm）的按北京时间取日；
 * 只有日期、或没写时区的原样截前 10 位（不猜时区）。已是 +08:00 的行结果不变。
 */
export function shanghaiDate(value: string): string {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) || !/T|\s\d/.test(value)) return value.slice(0, 10);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value.slice(0, 10);
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 抖音作品 id 是 19 位整数，超过 JS 安全整数；2026-10-03 之前入账的 id 被数字解析截成了
 * 「最短双精度写法」（…000 结尾）。这种 id 不可信：不参与绑定、不能拿来人工绑定，
 * 等下一次抓取带正确 id 的行按 latest-wins 覆盖。判据：超过安全整数且与自身的双精度写法完全相同
 * ——真实 id 恰好落在可精确表示的双精度上的概率约千分之一，宁可让这极少数等一轮重抓。
 */
export function isTruncatedItemId(platform: string, itemId: string): boolean {
  if (normalizePlatform(platform) !== "douyin") return false;
  const id = itemId.trim();
  if (!/^\d{17,}$/.test(id)) return false;
  const n = Number(id);
  return n > Number.MAX_SAFE_INTEGER && String(n) === id;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "");
}

export function validateOutcome(input: {
  /** 有平台时才能认出平台特有的真实小值（抖音完播率 <1%）；缺省按通用规则 */
  platform?: string;
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
  // 曝光是计数不是比率:小数一律是读错字段(如把曝光率填进了曝光量)
  if (m.impressions !== undefined && Number.isFinite(m.impressions) && !Number.isInteger(m.impressions)) {
    reasons.push(`曝光量 ${m.impressions} 不是整数`);
  }
  const rate = rateMetricIssues(m, input.platform);
  reasons.push(...rate.rejects);
  if (input.publishedAt) {
    const pubDate = shanghaiDate(input.publishedAt);
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
  review.push(...rate.reviews);
  return { ok: true, needsReview: review.length > 0, reasons: review };
}

interface KeyInput {
  contentId: string | null;
  platform: string;
  platformTitle: string;
  publishedAt: string | null;
  metricDate: string;
  platformItemId?: string;
}

/** 可信的平台作品 id（截坏的抖音 id 不算）；没有就是空串 */
export function trustedItemId(o: { platform: string; platformItemId?: string }): string {
  const id = (o.platformItemId ?? "").trim();
  return id && !isTruncatedItemId(o.platform, id) ? id : "";
}

/** 只按标题@日期（或 contentId）的旧键：作品标签等按旧键存过的东西用它查 */
export function titleOutcomeKey(o: KeyInput): string {
  const norm = normalizeTitle(o.platformTitle) || o.platformTitle;
  const item = o.contentId
    ? o.contentId
    : `${norm}@${o.publishedAt ? shanghaiDate(o.publishedAt) : "unknown"}`;
  return `${normalizePlatform(o.platform)}:${item}:${o.metricDate}`;
}

/**
 * 幂等键：platform : (contentId 或 归一化标题@发布日期) : metricDate，行带可信作品 id 时再加 #id。
 * 加 id 是为了同平台同标题同日的两条不同作品永不合并（2026-10-03：09-16 抖音私密 + 公开重发）；
 * 没有 id（CSV 等）或 id 截坏的行保持原来的标题@日期键，listOutcomes 会把它们并到唯一那条带 id 的作品上。
 */
export function outcomeKey(o: KeyInput): string {
  const id = trustedItemId(o);
  return id ? `${titleOutcomeKey(o)}#${id}` : titleOutcomeKey(o);
}
