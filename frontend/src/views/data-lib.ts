/**
 * 数据页的纯计算（数据页规格 §G.37–41）：月份、平台中位数、加粗、单元格三态、数字格式。
 * 形状与后端 GET /api/data（src/desktop/data-page.ts）一一对应。
 */
import { browserUnreachable, pullBadge, pullHint, type PullPlatformStatus } from "../pull-lib";

export interface Snapshot { metricDate: string; recordedAt: string | null; source: string; metrics: Record<string, number | null> }
export interface Work { key: string; platform: string; title: string; publishedAt: string | null; day: string | null; snapshots: Snapshot[] }
export interface DataRow {
  id: string;
  contentId: string | null;
  contentTitle: string | null;
  title: string;
  day: string | null;
  works: Work[];
  publishedOn: string[];
  link: "manual" | "auto" | "none";
  decisionId: string | null;
}
/** 一行的封面（§I）：手动补的 > AutoCrew 已选 3:4 封面 > 自动回流抓的 */
export type RowCover =
  | { kind: "manual"; file: string; key: string }
  | { kind: "autocrew"; contentId: string; path: string; sha256: string }
  | { kind: "auto"; file: string };
export interface Upcoming { contentId: string; title: string; time: string | null; state: string; platforms: string[] }
export interface DataPageData {
  columns: string[];
  rows: DataRow[];
  contents: Array<{ id: string; title: string; day: string | null }>;
  asOf: string | null;
  sources: string[];
  covers: Record<string, RowCover>;
  upcoming: Upcoming | null;
}

export function coverSrc(c: RowCover): string {
  if (c.kind === "autocrew") return `/api/project-artifact?content_id=${encodeURIComponent(c.contentId)}&path=${encodeURIComponent(c.path)}&sha256=${c.sha256}`;
  return `/api/data/cover-file?name=${encodeURIComponent(c.file)}`;
}

/** 自动回流会抓封面的平台：只有字段经真实抓包核实过的（抖音 work_list 的 Cover / cover） */
export const COVER_CAPTURE_PLATFORMS = ["douyin"];

/** 手动补封面：前端先挡一遍（服务端还会再按文件头校验） */
export function coverFileProblem(f: { type: string; size: number }): string | null {
  if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) return "只收 png / jpg / webp 图片";
  if (f.size > 10 * 1024 * 1024) return "图片超过 10MB，换一张小一点的";
  return null;
}

export type Period = "month" | "all";

export const latest = (w: Work): Snapshot => w.snapshots[w.snapshots.length - 1];

/** 北京时间的「本月」 */
export function currentMonth(now: number): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 7);
}

export const monthOf = (row: DataRow): string => row.day?.slice(0, 7) ?? "unknown";

export function monthLabel(m: string): string {
  if (m === "unknown") return "日期不明";
  return `${m.slice(0, 4)} 年 ${Number(m.slice(5, 7))} 月`;
}

/** §37：默认本月；本月没数据 → 最近有数据的月份，并标出来 */
export function pickMonth(rows: DataRow[], now: number): { month: string | null; fallback: boolean } {
  const cur = currentMonth(now);
  const months = [...new Set(rows.filter((r) => r.day).map(monthOf))].sort();
  if (months.includes(cur)) return { month: cur, fallback: false };
  return { month: months[months.length - 1] ?? null, fallback: true };
}

export function rowsInPeriod(rows: DataRow[], period: Period, month: string | null): DataRow[] {
  return period === "all" ? rows : rows.filter((r) => month !== null && monthOf(r) === month);
}

/** 按月分组，新的在前；组内已关联的在前、未关联的在后（§34 未关联分组），各自按日期新→旧 */
export function groupByMonth(rows: DataRow[]): Array<{ month: string; linked: DataRow[]; unlinked: DataRow[] }> {
  const byMonth = new Map<string, DataRow[]>();
  for (const r of rows) byMonth.set(monthOf(r), [...(byMonth.get(monthOf(r)) ?? []), r]);
  const newest = (a: DataRow, b: DataRow) => (b.day ?? "").localeCompare(a.day ?? "");
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a)))
    .map(([month, rs]) => ({
      month,
      linked: rs.filter((r) => r.contentId).sort(newest),
      unlinked: rs.filter((r) => !r.contentId).sort(newest),
    }));
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const MIN_SAMPLES = 3;

/** 每个平台的播放数（每条作品取最新快照）；同一行同平台多条只取第一条，与单元格口径一致 */
export function viewsByPlatform(rows: DataRow[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const w of r.works) {
      const v = latest(w).metrics.views;
      if (seen.has(w.platform) || typeof v !== "number") continue;
      seen.add(w.platform);
      out.set(w.platform, [...(out.get(w.platform) ?? []), v]);
    }
  }
  return out;
}

export interface PlatformCard { platform: string; count: number; median: number | null }

/** §38：该时段有数据的平台才出卡；少于 3 条不给中位数 */
export function platformCards(rows: DataRow[], columns: string[]): PlatformCard[] {
  const byP = viewsByPlatform(rows);
  return columns.flatMap((platform) => {
    const vs = byP.get(platform) ?? [];
    if (!vs.length) return [];
    return [{ platform, count: vs.length, median: vs.length >= MIN_SAMPLES ? median(vs) : null }];
  });
}

/** §40：加粗的门槛 = 该平台全部历史的中位数；历史样本不足 3 条就不加粗 */
export function boldThresholds(allRows: DataRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [p, vs] of viewsByPlatform(allRows)) {
    const m = vs.length >= MIN_SAMPLES ? median(vs) : null;
    if (m !== null) out.set(p, m);
  }
  return out;
}

export type Cell =
  | { kind: "data"; views: number | null; rate: number | null; bold: boolean; work: Work }
  | { kind: "missing" } // 发了，数据没回来：「未回流」
  | { kind: "none" }; // 这个平台没发：「—」

/** §39：有数据 / 发了没回流 / 没发，三态分开 */
export function cellOf(row: DataRow, platform: string, thresholds: Map<string, number>): Cell {
  const w = row.works.find((x) => x.platform === platform);
  if (w) {
    const m = latest(w).metrics;
    const views = typeof m.views === "number" ? m.views : null;
    const t = thresholds.get(platform);
    return { kind: "data", views, rate: typeof m.completionRate === "number" ? m.completionRate : null, bold: views !== null && t !== undefined && views > t, work: w };
  }
  return row.publishedOn.includes(platform) ? { kind: "missing" } : { kind: "none" };
}

/** §41：百分比统一一位小数 */
export const fmtRate = (n: number): string => `${n.toFixed(1)}%`;
export const fmtViews = (n: number): string => Math.round(n).toLocaleString("zh-CN");

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
export function dayLabel(day: string | null): string {
  if (!day) return "日期不明";
  return `${day.slice(5)} 周${WEEK[new Date(`${day}T00:00:00Z`).getUTCDay()]}`;
}

const SOURCE_LABELS: Record<string, string> = { csv: "CSV 导入", auto: "自动回流", paste: "手动录入" };
export const sourceLabel = (s: string): string => SOURCE_LABELS[s] ?? s;

/** §42 / §43：右上那一行的自动回流部分。problem 非空 = 这一行变红写原因 */
export function pullLine(rows: PullPlatformStatus[] | null, err: string | null): { state: string; problem: string | null } {
  if (err) return { state: "自动回流状态读不出来", problem: `自动回流状态读不出来：${err}` };
  if (!rows) return { state: "自动回流状态读取中", problem: null };
  const on = rows.filter((r) => r.enabled);
  const covers = on.flatMap((r) => { const m = r.lastCoverError?.match(/^cover_download_failed:(\d+)\/(\d+)/); return m ? [`${r.label}封面 ${m[1]}/${m[2]} 张没下载成`] : []; });
  const state = (on.length ? `自动回流已开（${on.map((r) => r.label).join("、")}）` : "自动回流没开") + (covers.length ? `（${covers.join("；")}）` : "");
  // 当前的写入权拒绝优先于资料库里旧的浏览器状态
  const refused = rows.filter((r) => r.writeRefusal);
  if (refused.length) return { state, problem: refused.map((r) => `${r.label}${pullBadge(r).text}：${pullHint(r)}`).join("；") };
  if (on.length && browserUnreachable(rows)) return { state, problem: "自动回流连不上浏览器（chrome-cdp），数据停在上次" };
  const bad = on.filter((r) => { const t = pullBadge(r).tone; return t === "bad" || t === "warn"; });
  if (!bad.length) return { state, problem: null };
  return { state, problem: bad.map((r) => `${r.label}${pullBadge(r).text}：${pullHint(r) ?? "上次没抓成"}`).join("；") };
}
