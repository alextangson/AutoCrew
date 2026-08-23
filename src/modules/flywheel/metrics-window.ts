/**
 * 复盘时间口径聚合层（spec §5.2）—— 纯函数，零 IO。
 *
 * outcome 是**累计快照**：直接按 metricDate 切窗，会把「本周重抓的 200 条老作品」
 * 一辈子的播放全算成本期表现（codex #3，阻断级）。所以复盘只认三种视图：
 *   增量视图 deltaInWindow   —— 同作品相邻快照差分：窗口内**新增**多少；
 *   cohort 视图 publishCohort —— 窗口内发布的稿件：各自最新快照累计值 + 发布龄期；
 *   定龄视图 metricsAtAge    —— 作品在 D+N 的首个快照，跨作品公平比较。
 *
 * 跨平台纪律（spec §5.2）：绝对量（播放/曝光/赞…）只在同平台内聚合——所有小计一律挂在
 * `byPlatform` 下，**结构里没有全局合计**；率类（完播率/互动率）才可跨平台。
 * impressions 与 views 永远分列，不合并、不互相 fallback（曝光 ≠ 播放，codex #4）。
 *
 * 日期口径：metricDate 是 YYYY-MM-DD；publishedAt 取 ISO 的 UTC 日期段。两者时区可能差
 * 一天 —— 龄期误差 ≤1 天，不做时区推算（推算需要创作者所在时区，那是编数据）。
 */
import { outcomeKey, type OutcomeMetrics, type PerformanceOutcome } from "./outcome-schema.js";

/** 绝对量（计数类）：只在同平台内聚合 */
export const COUNTER_METRICS = [
  "views",
  "impressions",
  "likes",
  "comments",
  "shares",
  "favorites",
  "follows",
] as const;
export type CounterMetric = (typeof COUNTER_METRICS)[number];
export type CounterTotals = Partial<Record<CounterMetric, number>>;

/** 率类：可跨平台比较（口径写在字段注释里，展示时必须带上） */
export interface RateMetrics {
  /** 平台给的完播率原值（%）——增量视图里取窗口末快照值，率不做差分 */
  completionRate?: number;
  /** 互动率 =（赞+评+转）/播放 ×100（%） */
  engagementRate?: number;
}

/** 窗口起点前多久的快照仍可当基线：默认 7 天（12h~24h 抓取节奏下基线通常就是前一天） */
export const DEFAULT_BASELINE_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

function dayStamp(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

/** 发布 → 数据日期 的整天数；任一不可解析 → null */
export function ageInDays(publishedAt: string, metricDate: string): number | null {
  const from = dayStamp(publishedAt);
  const to = dayStamp(metricDate);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / DAY_MS);
}

/** 中位数；空样本 → null（不拿 0 冒充「没有数据」） */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 互动率 + 完播率；播放为 0/缺失时互动率不给（除以 0 是编数据） */
export function computeRates(m: OutcomeMetrics | CounterTotals): RateMetrics {
  const rates: RateMetrics = {};
  const completion = (m as OutcomeMetrics).completionRate;
  if (typeof completion === "number") rates.completionRate = completion;
  const views = m.views;
  if (typeof views === "number" && views > 0) {
    const engaged = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0);
    rates.engagementRate = (engaged / views) * 100;
  }
  return rates;
}

/** 作品视角的一组快照（entityKey = outcomeKey 去掉 metricDate 段） */
export interface EntityGroup {
  entityKey: string;
  platform: string;
  contentId: string | null;
  title: string;
  publishedAt: string | null;
  /** 按 metricDate 升序 */
  snapshots: PerformanceOutcome[];
}

export function entityKey(o: PerformanceOutcome): string {
  return outcomeKey({ ...o, metricDate: "" });
}

/** 把快照流按作品分组。同一 entityKey 的 contentId/平台恒定（它们就在键里） */
export function groupByEntity(outcomes: PerformanceOutcome[]): EntityGroup[] {
  const groups = new Map<string, EntityGroup>();
  for (const o of outcomes) {
    const key = entityKey(o);
    let g = groups.get(key);
    if (!g) {
      g = {
        entityKey: key,
        platform: o.platform,
        contentId: o.contentId,
        title: o.platformTitle,
        publishedAt: o.publishedAt,
        snapshots: [],
      };
      groups.set(key, g);
    }
    if (!g.publishedAt && o.publishedAt) g.publishedAt = o.publishedAt;
    g.snapshots.push(o);
  }
  for (const g of groups.values()) {
    g.snapshots.sort((a, b) => (a.metricDate < b.metricDate ? -1 : a.metricDate > b.metricDate ? 1 : 0));
    g.title = g.snapshots[g.snapshots.length - 1].platformTitle;
  }
  return [...groups.values()];
}

// ───────────────────────── 增量视图 ─────────────────────────

/** 增量基线的来源，报告里要如实标注——三种口径的可信度不一样 */
export type DeltaBasis =
  /** 窗口前(宽限期内)的快照做基线：最准 */
  | "prior_snapshot"
  /** 窗口内首尾差分：窗口起点到首个快照那段没算进来，宁可少算不多算 */
  | "in_window_span"
  /** 本窗口内发布：累计值本身就是窗口增量 */
  | "published_in_window";

export interface DeltaItem {
  entityKey: string;
  platform: string;
  contentId: string | null;
  title: string;
  basis: DeltaBasis;
  /** 基线快照日期；published_in_window 时为 null（基线是真零） */
  baseDate: string | null;
  /** 窗口内最后一个快照日期 */
  toDate: string;
  /** 增量：负值（平台修数）夹到 0 */
  delta: CounterTotals;
  /** 未夹的原始增量：夹过的那几个指标在这里能看到真实负值 */
  rawDelta: CounterTotals;
  /** 被夹到 0 的指标名 */
  clamped: CounterMetric[];
  rates: RateMetrics;
}

export interface PlatformDeltaTotal {
  platform: string;
  works: number;
  totals: CounterTotals;
  rates: RateMetrics;
}

export interface WindowDelta {
  from: string;
  to: string;
  items: DeltaItem[];
  /** 绝对量小计只按平台出（跨平台加总在结构上就不存在） */
  byPlatform: PlatformDeltaTotal[];
  /** 窗口内有快照但定不出基线：不插值、不进小计，如实报给复盘 */
  noBaseline: Array<{ entityKey: string; platform: string; title: string; reason: string }>;
}

function diffCounters(base: OutcomeMetrics | null, end: OutcomeMetrics) {
  const delta: CounterTotals = {};
  const rawDelta: CounterTotals = {};
  const clamped: CounterMetric[] = [];
  for (const key of COUNTER_METRICS) {
    const to = end[key];
    if (typeof to !== "number") continue;
    const from = base ? base[key] : 0;
    if (base && typeof from !== "number") continue; // 基线缺这个指标：不猜 0，整项跳过
    const raw = to - (from ?? 0);
    rawDelta[key] = raw;
    delta[key] = raw < 0 ? 0 : raw;
    if (raw < 0) clamped.push(key);
  }
  return { delta, rawDelta, clamped };
}

/** 单个作品在窗口内的基线选择：三种口径按可信度依次尝试 */
function pickBaseline(
  g: EntityGroup,
  inWindow: PerformanceOutcome[],
  from: string,
  graceDays: number,
): { basis: DeltaBasis; base: OutcomeMetrics | null; baseDate: string | null; end: PerformanceOutcome } | string {
  const end = inWindow[inWindow.length - 1];
  const pubDate = g.publishedAt ? g.publishedAt.slice(0, 10) : null;
  if (pubDate && pubDate >= from) {
    return { basis: "published_in_window", base: null, baseDate: null, end };
  }
  const graceFloor = new Date(dayStamp(from) - graceDays * DAY_MS).toISOString().slice(0, 10);
  const prior = [...g.snapshots].reverse().find((s) => s.metricDate < from && s.metricDate >= graceFloor);
  if (prior) return { basis: "prior_snapshot", base: prior.metrics, baseDate: prior.metricDate, end };
  if (inWindow.length >= 2) {
    return { basis: "in_window_span", base: inWindow[0].metrics, baseDate: inWindow[0].metricDate, end };
  }
  return g.snapshots.some((s) => s.metricDate < from)
    ? `上一份快照早于 ${graceDays} 天宽限期，窗口内只有 1 份快照，增量无法归因`
    : "窗口内只有 1 份快照且此前无快照，无基线可差分";
}

function summarizeByPlatform(items: DeltaItem[]): PlatformDeltaTotal[] {
  const byPlatform = new Map<string, PlatformDeltaTotal>();
  for (const item of items) {
    let row = byPlatform.get(item.platform);
    if (!row) {
      row = { platform: item.platform, works: 0, totals: {}, rates: {} };
      byPlatform.set(item.platform, row);
    }
    row.works += 1;
    for (const key of COUNTER_METRICS) {
      const v = item.delta[key];
      if (typeof v === "number") row.totals[key] = (row.totals[key] ?? 0) + v;
    }
  }
  for (const row of byPlatform.values()) {
    const completion = median(
      items.filter((i) => i.platform === row.platform && typeof i.rates.completionRate === "number")
        .map((i) => i.rates.completionRate as number),
    );
    row.rates = computeRates(row.totals);
    if (completion !== null) row.rates.completionRate = completion;
  }
  return [...byPlatform.values()];
}

/**
 * 增量视图：同作品相邻快照差分，得出 [from, to] 内新增的播放/赞/评/转。
 * 快照缺口不插值（定不出基线的作品进 noBaseline），负增量（平台修数）夹到 0 但 rawDelta 留原值。
 */
export function deltaInWindow(
  outcomes: PerformanceOutcome[],
  from: string,
  to: string,
  opts?: { baselineGraceDays?: number },
): WindowDelta {
  const graceDays = opts?.baselineGraceDays ?? DEFAULT_BASELINE_GRACE_DAYS;
  const items: DeltaItem[] = [];
  const noBaseline: WindowDelta["noBaseline"] = [];

  for (const g of groupByEntity(outcomes)) {
    const inWindow = g.snapshots.filter((s) => s.metricDate >= from && s.metricDate <= to);
    if (inWindow.length === 0) continue; // 窗口内无快照 = 本期无数据，不是 0 增长
    const picked = pickBaseline(g, inWindow, from, graceDays);
    if (typeof picked === "string") {
      noBaseline.push({ entityKey: g.entityKey, platform: g.platform, title: g.title, reason: picked });
      continue;
    }
    const { delta, rawDelta, clamped } = diffCounters(picked.base, picked.end.metrics);
    const rates = computeRates(delta);
    if (typeof picked.end.metrics.completionRate === "number") {
      rates.completionRate = picked.end.metrics.completionRate;
    }
    items.push({
      entityKey: g.entityKey,
      platform: g.platform,
      contentId: g.contentId,
      title: g.title,
      basis: picked.basis,
      baseDate: picked.baseDate,
      toDate: picked.end.metricDate,
      delta,
      rawDelta,
      clamped,
      rates,
    });
  }

  return { from, to, items, byPlatform: summarizeByPlatform(items), noBaseline };
}

// ───────────────────────── cohort 视图 ─────────────────────────

/** 只要稿件元数据的这几个字段——Content 结构上满足，测试也不必造整个 Content */
export interface CohortContentMeta {
  id: string;
  title: string;
  platform?: string;
  publishedAt?: string | null;
}

export interface CohortItem {
  contentId: string;
  title: string;
  platform: string;
  publishedAt: string;
  /** 最新快照日期；无快照 → null */
  latestMetricDate: string | null;
  /** 发布 → 最新快照 的天数（作品「跑了几天」，累计值必须配着龄期看） */
  ageDays: number | null;
  snapshotCount: number;
  /** 截至最新快照的累计值；无快照 → null（不是 0） */
  cumulative: OutcomeMetrics | null;
  rates: RateMetrics;
}

export interface CohortResult {
  from: string;
  to: string;
  items: CohortItem[];
  byPlatform: Array<{ platform: string; works: number; withData: number; totals: CounterTotals }>;
  /** 窗口内发布但一条快照都没有的稿件数 */
  missingData: number;
}

/**
 * cohort 视图：[from, to] 内发布的稿件 → 各自最新快照的累计值 + 发布龄期。
 * 回答的是「本期新发的东西跑得怎么样」，与增量视图（含老作品的本期新增）互补。
 */
export function publishCohort(
  contents: CohortContentMeta[],
  outcomes: PerformanceOutcome[],
  from: string,
  to: string,
): CohortResult {
  const byContent = new Map<string, EntityGroup>();
  for (const g of groupByEntity(outcomes)) {
    if (g.contentId) byContent.set(g.contentId, g);
  }

  const items: CohortItem[] = [];
  for (const c of contents) {
    const pubDate = c.publishedAt ? c.publishedAt.slice(0, 10) : null;
    if (!pubDate || pubDate < from || pubDate > to) continue;
    const g = byContent.get(c.id);
    const latest = g ? g.snapshots[g.snapshots.length - 1] : undefined;
    items.push({
      contentId: c.id,
      title: c.title,
      platform: c.platform || g?.platform || "未定平台",
      publishedAt: c.publishedAt as string,
      latestMetricDate: latest?.metricDate ?? null,
      ageDays: latest ? ageInDays(c.publishedAt as string, latest.metricDate) : null,
      snapshotCount: g?.snapshots.length ?? 0,
      cumulative: latest?.metrics ?? null,
      rates: latest ? computeRates(latest.metrics) : {},
    });
  }

  return {
    from,
    to,
    items,
    byPlatform: cohortByPlatform(items),
    missingData: items.filter((i) => i.cumulative === null).length,
  };
}

function cohortByPlatform(items: CohortItem[]): CohortResult["byPlatform"] {
  const byPlatform = new Map<string, CohortResult["byPlatform"][number]>();
  for (const item of items) {
    let row = byPlatform.get(item.platform);
    if (!row) {
      row = { platform: item.platform, works: 0, withData: 0, totals: {} };
      byPlatform.set(item.platform, row);
    }
    row.works += 1;
    if (!item.cumulative) continue;
    row.withData += 1;
    for (const key of COUNTER_METRICS) {
      const v = item.cumulative[key];
      if (typeof v === "number") row.totals[key] = (row.totals[key] ?? 0) + v;
    }
  }
  return [...byPlatform.values()];
}

// ───────────────────────── 定龄视图 ─────────────────────────

export interface AtAgeSnapshot {
  metricDate: string;
  /** 实际龄期（≥ 请求龄期；平台没在正日子给快照就是这样，不插值） */
  ageDays: number;
  metrics: OutcomeMetrics;
  rates: RateMetrics;
}

/**
 * 定龄视图：某作品「龄期 ≥N 天的首个快照」。传入的是**该作品**的快照集合
 * （调用方用 groupByEntity 分组，或直接给某 contentId 的行）。
 * 没有到龄快照 → null（不拿最近一条冒充 D+7，那会让新作品显得比老作品差）。
 */
export function metricsAtAge(
  outcomes: PerformanceOutcome[],
  publishedAt: string | null,
  ageDays: number,
): AtAgeSnapshot | null {
  if (!publishedAt) return null;
  const sorted = [...outcomes].sort((a, b) => (a.metricDate < b.metricDate ? -1 : 1));
  for (const s of sorted) {
    const age = ageInDays(publishedAt, s.metricDate);
    if (age === null || age < ageDays) continue;
    return { metricDate: s.metricDate, ageDays: age, metrics: s.metrics, rates: computeRates(s.metrics) };
  }
  return null;
}

export interface AgeCohortEntry {
  entityKey: string;
  platform: string;
  contentId: string | null;
  title: string;
  publishedAt: string;
  at: AtAgeSnapshot;
}

/** 全账号的 D+N 定龄读数——假设裁决的对照基线就建在这上面 */
export function metricsAtAgeAll(outcomes: PerformanceOutcome[], ageDays: number): AgeCohortEntry[] {
  const entries: AgeCohortEntry[] = [];
  for (const g of groupByEntity(outcomes)) {
    const at = metricsAtAge(g.snapshots, g.publishedAt, ageDays);
    if (!at || !g.publishedAt) continue;
    entries.push({
      entityKey: g.entityKey,
      platform: g.platform,
      contentId: g.contentId,
      title: g.title,
      publishedAt: g.publishedAt,
      at,
    });
  }
  return entries;
}

/** 定龄读数里取某个指标的值（率类走 rates，计数类走 metrics） */
export function readMetric(at: AtAgeSnapshot, metric: keyof OutcomeMetrics | "engagementRate"): number | undefined {
  if (metric === "engagementRate") return at.rates.engagementRate;
  const v = at.metrics[metric];
  return typeof v === "number" ? v : undefined;
}
