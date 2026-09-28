/**
 * 全部作品表的指标切换（创始人 09-28 反馈）：每格显示所选指标（最新快照）。
 * 「平台提供不提供」按实际数据判断，不写死；点击率只在有曝光数的平台由 播放 ÷ 曝光 推出来，不编别的来源。
 */
import { MIN_SAMPLES, latest, median, type DataRow, type Work } from "./data-lib";

export type MetricId = "views" | "ctr" | "completionRate" | "completion5s" | "likes" | "comments" | "favorites" | "shares" | "follows";
export interface Metric { id: MetricId; label: string; rate: boolean }
export const METRICS: Metric[] = [
  { id: "views", label: "播放", rate: false },
  { id: "ctr", label: "点击率", rate: true },
  { id: "completionRate", label: "完播率", rate: true },
  { id: "completion5s", label: "5秒完播", rate: true },
  { id: "likes", label: "点赞", rate: false },
  { id: "comments", label: "评论", rate: false },
  { id: "favorites", label: "收藏", rate: false },
  { id: "shares", label: "分享", rate: false },
  { id: "follows", label: "涨粉", rate: false },
];
export const metricOf = (id: MetricId): Metric => METRICS.find((m) => m.id === id)!;
export const isMetricId = (v: unknown): v is MetricId => METRICS.some((m) => m.id === v);

/** 一条作品最新快照里的指标值；点击率 = 播放 ÷ 曝光（百分数），曝光为 0 或缺 → 没有 */
export function metricValue(w: Work, id: MetricId): number | null {
  const m = latest(w).metrics;
  if (id === "ctr") {
    const v = m.views, imp = m.impressions;
    return typeof v === "number" && typeof imp === "number" && imp > 0 ? (v / imp) * 100 : null;
  }
  const v = m[id];
  return typeof v === "number" ? v : null;
}

/** 每个平台实际报过哪些指标（任一作品任一值非空即算提供） */
export function availability(rows: DataRow[]): Map<string, Set<MetricId>> {
  const out = new Map<string, Set<MetricId>>();
  for (const r of rows) for (const w of r.works) {
    const set = out.get(w.platform) ?? new Set<MetricId>();
    for (const m of METRICS) if (metricValue(w, m.id) !== null) set.add(m.id);
    out.set(w.platform, set);
  }
  return out;
}

/** 加粗门槛：该平台全部历史在这个指标上的中位数（同一行同平台取第一条，与单元格一致）；不足 3 条不加粗 */
export function metricThresholds(allRows: DataRow[], id: MetricId): Map<string, number> {
  const vals = new Map<string, number[]>();
  for (const r of allRows) {
    const seen = new Set<string>();
    for (const w of r.works) {
      if (seen.has(w.platform)) continue;
      seen.add(w.platform);
      const v = metricValue(w, id);
      if (v !== null) vals.set(w.platform, [...(vals.get(w.platform) ?? []), v]);
    }
  }
  const out = new Map<string, number>();
  for (const [p, vs] of vals) if (vs.length >= MIN_SAMPLES) out.set(p, median(vs)!);
  return out;
}

export type MetricCell =
  | { kind: "data"; value: number; bold: boolean }
  | { kind: "none" } // 这个平台没发：「—」
  | { kind: "missing" } // 发了，数据还没回来：「未回流」
  | { kind: "unsupported" }; // 这个平台从不报这个指标：「平台不提供」

export function metricCell(row: DataRow, platform: string, id: MetricId, thresholds: Map<string, number>, avail: Map<string, Set<MetricId>>): MetricCell {
  const w = row.works.find((x) => x.platform === platform);
  if (!w) return row.publishedOn.includes(platform) ? { kind: "missing" } : { kind: "none" };
  if (!avail.get(platform)?.has(id)) return { kind: "unsupported" };
  const value = metricValue(w, id);
  if (value === null) return { kind: "missing" };
  const t = thresholds.get(platform);
  return { kind: "data", value, bold: t !== undefined && value > t };
}

export function fmtMetric(id: MetricId, v: number): string {
  return metricOf(id).rate ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString("zh-CN");
}

const STORE_KEY = "autocrew.data.metric";
export function loadMetric(): MetricId {
  try { const v = localStorage.getItem(STORE_KEY); return isMetricId(v) ? v : "views"; } catch { return "views"; }
}
export function saveMetric(id: MetricId): void {
  try { localStorage.setItem(STORE_KEY, id); } catch { /* 隐私模式存不住：只是下次回到默认 */ }
}
