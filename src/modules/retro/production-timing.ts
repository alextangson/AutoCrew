/**
 * 内容生产计时（复盘的「用时段」）——**确定性计算，不经 LLM**。
 *
 * 三段口径（起止都读稿件自己的时间戳，一律不推算、不补全）：
 *   开写 → 稿成    createdAt   → draftReadyAt   （占位稿创建即开写）
 *   稿成 → 发布    draftReadyAt → publishedAt
 *   全程          createdAt   → publishedAt
 *
 * 缺戳的旧稿（转正戳上线前写的稿）直接跳过并计数，宁可少算不可编造：
 * 报告里出现的每一个用时，都来自两个真实落盘的时间戳。
 */
import type { Content } from "../../storage/local-store.js";

export interface DurationStat {
  /** 参与本段计算的篇数（缺戳/时序倒挂的稿不计入） */
  count: number;
  medianMs: number | null;
  /** 人话中位数，如「1 天 3 小时」；无样本时 null */
  medianText: string | null;
}

export interface ProductionTiming {
  /** 窗口内已发布篇数（三段统计的分母上限） */
  published: number;
  /** 开写 → 稿成 */
  drafting: DurationStat;
  /** 稿成 → 发布 */
  toPublish: DurationStat;
  /** 全程：开写 → 发布 */
  endToEnd: DurationStat;
  /** 缺时间戳（或时序倒挂）导致未能算全三段的篇数 */
  missingStamps: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 人话时长：粗到「天+小时」为止——复盘看的是量级，不是秒表 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < MINUTE) return "不到 1 分钟";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} 分钟`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MINUTE);
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`;
}

/** 两个时间戳之间的毫秒数；任一缺失/不可解析/时序倒挂 → null（该样本作废，不参与统计） */
function span(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function stat(values: number[]): DurationStat {
  if (values.length === 0) return { count: 0, medianMs: null, medianText: null };
  const m = median(values);
  return { count: values.length, medianMs: m, medianText: formatDuration(m) };
}

/**
 * 统计一批「窗口内已发布」的稿件。调用方负责窗口过滤（publishedAt 落在本期）；
 * 本函数只做算术，不读盘、不猜时间。
 */
export function computeProductionTiming(published: Content[]): ProductionTiming {
  const drafting: number[] = [];
  const toPublish: number[] = [];
  const endToEnd: number[] = [];
  let missingStamps = 0;

  for (const c of published) {
    const d = span(c.createdAt, c.draftReadyAt);
    const p = span(c.draftReadyAt, c.publishedAt);
    const e = span(c.createdAt, c.publishedAt);
    if (d !== null) drafting.push(d);
    if (p !== null) toPublish.push(p);
    if (e !== null) endToEnd.push(e);
    if (d === null || p === null || e === null) missingStamps += 1;
  }

  return {
    published: published.length,
    drafting: stat(drafting),
    toPublish: stat(toPublish),
    endToEnd: stat(endToEnd),
    missingStamps,
  };
}

const SEGMENT_LABELS: Array<[keyof Pick<ProductionTiming, "drafting" | "toPublish" | "endToEnd">, string]> = [
  ["drafting", "开写→稿成"],
  ["toPublish", "稿成→发布"],
  ["endToEnd", "全程(开写→发布)"],
];

/**
 * 注入复盘 prompt 的事实段。无样本时明说「无数据」并给出原因，
 * 绝不留空让模型自由发挥（空白 = 模型编数字的邀请函）。
 */
export function timingFactsBlock(t: ProductionTiming): string {
  if (t.published === 0) return "内容生产用时:本期无已发布稿件,无用时可算(不要编造用时)。";
  const lines = [`内容生产用时(按已落盘时间戳确定性计算,本期发布 ${t.published} 篇):`];
  for (const [key, label] of SEGMENT_LABELS) {
    const s = t[key];
    lines.push(s.count > 0 ? `- ${label}:中位 ${s.medianText}(${s.count} 篇)` : `- ${label}:无数据`);
  }
  if (t.missingStamps > 0) {
    lines.push(`- ${t.missingStamps} 篇缺时间戳未计入(戳上线前的旧稿,不做推算)`);
  }
  lines.push("以上用时是算好的事实,直接引用,不要自己重算或推测。");
  return lines.join("\n");
}
