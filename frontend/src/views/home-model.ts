/**
 * 首页「今天」的纯计算（管线重规划 §1、§5、§8-9，第 3 期）。
 * - 账号格：回流健康 + 第 4 期账号快照（粉丝、较昨天、昨天播放/阅读、7 天小折线）；没有的数不编。
 * - 刚发那条：能同龄比（别的作品发出同样时长时的播放）就同龄比；不够样本退回数据页的全量中位数并写明。
 * - 管线一览：/api/pipeline 的列计数 + 一句短提示。
 */
import { pullHint, type PullPlatformStatus } from "../pull-lib";
import { baselines, latestVideo, platformLines, daysAfter } from "./data-answers";
import { MIN_SAMPLES, median, type DataPageData, type DataRow, type Snapshot, type Work } from "./data-lib";
import { PIPELINE_COLUMNS, statusLine, type PipelineColumn, type PipelineData } from "./pipeline-model";

/** 账号区的主格（mock 的五格）；YouTube / X 在下面一行小字 */
export const MAIN_PLATFORMS = ["douyin", "wechat_video", "xiaohongshu", "bilibili", "wechat_mp"] as const;
export const LATER_PLATFORMS = ["youtube", "x"] as const;
const ALL: readonly string[] = [...MAIN_PLATFORMS, ...LATER_PLATFORMS];

export type AccountState =
  | { kind: "ok"; at: string | null }
  | { kind: "login"; hint: string; consoleUrl: string; lastSuccessAt: string | null }
  | { kind: "problem"; text: string }
  | { kind: "off" }
  | { kind: "never" }
  | { kind: "running" }
  | { kind: "unsupported" }
  | { kind: "unknown"; error: string };
export interface AccountCell { platform: string; label: string; state: AccountState }

/** 勾了的平台 ∩ 视频 / 图文平台，按 mock 顺序 */
export function enabledPlatforms(profile: string[]): { main: string[]; later: string[] } {
  const on = new Set(profile);
  return { main: MAIN_PLATFORMS.filter((p) => on.has(p)), later: LATER_PLATFORMS.filter((p) => on.has(p)) };
}

/** 一个平台的回流健康：读不了就说读不了；不支持的平台写「还不能自动回流」 */
export function accountState(platform: string, pull: PullPlatformStatus[] | null, pullError: string | null): AccountState {
  if (pullError || !pull) return { kind: "unknown", error: pullError ?? "读取中" };
  const r = pull.find((x) => x.platform === platform);
  if (!r) return { kind: "unsupported" };
  if (r.inFlight) return { kind: "running" };
  if (r.writeRefusal) return { kind: "problem", text: pullHint(r) ?? "自动回流暂停" };
  if (!r.enabled) return { kind: "off" };
  if (r.lastStatus === "never") return { kind: "never" };
  if (r.lastStatus === "ok") return { kind: "ok", at: r.lastSuccessAt };
  if (r.lastStatus === "needs_login") return { kind: "login", hint: pullHint(r) ?? "登录态过期", consoleUrl: r.consoleUrl, lastSuccessAt: r.lastSuccessAt };
  return { kind: "problem", text: pullHint(r) ?? "上次没抓成" };
}

export function accountCells(platforms: string[], pull: PullPlatformStatus[] | null, pullError: string | null, label: (p: string) => string): AccountCell[] {
  return platforms.filter((p) => ALL.includes(p)).map((platform) => ({ platform, label: label(platform), state: accountState(platform, pull, pullError) }));
}

// ── 账号快照的数（后端 flywheel:pull_status 每平台带 account） ────────────────

export interface AccountTileData {
  health: { lastStatus: string; lastSuccessAt: string | null; lastErrorCode?: string } | null;
  latest: { metricDate: string; followers: number | null; newFollowers: number | null; views: number | null; viewsKind: "plays" | "reads"; complete: boolean } | null;
  followersDelta: number | null;
  compare: "ok" | "no_prev" | "no_data";
  series: Array<{ date: string; views: number }>;
}

export type AccountNumbers =
  | { kind: "none"; text: string }
  | { kind: "data"; followers: number | null; deltaText: string; deltaTone: "up" | "down" | "flat" | "none"; viewsText: string; staleText: string | null; series: number[] };

const fmtN = (n: number): string => n.toLocaleString("zh-CN");
/** 北京时间的昨天 YYYY-MM-DD */
export const beijingYesterday = (now: number): string => new Date(now + 8 * HOUR_MS - 86_400_000).toISOString().slice(0, 10);
const HOUR_MS = 3_600_000;

/** 一格账号数：没快照就说为什么没有；有就给粉丝、较昨天、那天的播放/阅读；不是昨天的数写明截至哪天 */
export function accountNumbers(acct: AccountTileData | { error: string } | null | undefined, now: number): AccountNumbers {
  if (acct === null || acct === undefined) return { kind: "none", text: "还不能抓账号数据" };
  if ("error" in acct) return { kind: "none", text: acct.error };
  const h = acct.health;
  const failed = h && h.lastStatus !== "ok" && h.lastStatus !== "never" ? `账号数据没抓成（${h.lastErrorCode ?? h.lastStatus}）` : null;
  const l = acct.latest;
  if (!l) return { kind: "none", text: failed ?? "还没有账号数据，下次回流后出现" };
  const d = acct.followersDelta;
  const deltaText = acct.compare !== "ok" || d === null ? "明天开始有对比" : d === 0 ? "和昨天持平" : `${d > 0 ? "+" : "−"}${fmtN(Math.abs(d))} 较昨天`;
  const deltaTone = acct.compare !== "ok" || d === null ? "none" : d > 0 ? "up" : d < 0 ? "down" : "flat";
  const yest = beijingYesterday(now);
  const when = l.metricDate === yest ? "昨天" : l.metricDate.slice(5);
  const unit = l.viewsKind === "reads" ? "阅读" : "播放";
  const viewsText = l.views === null ? `${when}${unit}没拿到` : `${when}${unit} ${fmtN(l.views)}`;
  const staleText = l.metricDate < yest ? `数据截至 ${l.metricDate.slice(5)}${failed ? `；${failed}` : ""}` : failed;
  return { kind: "data", followers: l.followers, deltaText, deltaTone, viewsText, staleText, series: acct.series.length >= 2 ? acct.series.map((x) => x.views) : [] };
}

/** 小折线的点（viewBox 120×32，上下各留 4） */
export function sparkPoints(values: number[]): string {
  if (values.length < 2) return "";
  const max = Math.max(...values), min = Math.min(...values), span = max - min || 1;
  return values.map((v, i) => `${((i / (values.length - 1)) * 120).toFixed(1)},${(28 - ((v - min) / span) * 24).toFixed(1)}`).join(" ");
}

// ── 刚发那条 ───────────────────────────────────────────────────────────────

export interface PerfLine {
  platform: string;
  /** data = 有数字；pending = 数据还没回来 / 不满 24 小时 */
  kind: "data" | "pending";
  views?: number;
  baseline?: number | null;
  ratio?: number | null;
  /** 条宽与「平时」刻度的位置（0–100）；没平时就只画条 */
  barPct?: number;
  basePct?: number | null;
  verdict?: { text: string; tone: "up" | "down" | "flat" | "none" };
  /** 「平时」怎么算的：same_age = 别的作品发出同样时长时的播放中位数；all = 所有作品最新播放中位数（同龄样本不够） */
  basis?: "same_age" | "all";
  /** 这条数据是发出后约几小时抓的 */
  ageHours?: number;
}
export interface Latest { rowId: string; contentId: string | null; title: string; day: string | null; after: number | null; lines: PerfLine[] }

/** 比值 → 右侧那句：≥1.05 写倍数，<0.5 远低于，<0.9 低于，其余差不多 */
export function verdictOf(ratio: number | null): NonNullable<PerfLine["verdict"]> {
  if (ratio === null) return { text: "平时样本太少，暂不比较", tone: "none" };
  if (ratio >= 1.05) return { text: `${ratio.toFixed(1)}×`, tone: "up" };
  if (ratio < 0.5) return { text: "远低于平时", tone: "down" };
  if (ratio < 0.9) return { text: `平时的 ${Math.round(ratio * 100)}%`, tone: "down" };
  return { text: "和平时差不多", tone: "flat" };
}

/** 满格 = 两者里大的那个再留一点余量（mock：大的那个落在 92%） */
export function barOf(views: number, baseline: number | null): { barPct: number; basePct: number | null } {
  const scale = Math.max(views, baseline ?? 0) / 0.92 || 1;
  const pct = (n: number) => Math.max(0, Math.min(100, (n / scale) * 100));
  return { barPct: pct(views), basePct: baseline ? pct(baseline) : null };
}

const HOUR = 3_600_000;
/** 快照的抓取时刻：有入账时间用它，旧行只有数据日就按那天 09:00（北京）算 */
const snapAt = (s: Snapshot): number => Date.parse(s.recordedAt ?? `${s.metricDate}T01:00:00.000Z`);
const viewsAt = (s: Snapshot): number | null => (typeof s.metrics.views === "number" ? s.metrics.views : null);

/** 一条作品的最新快照是发出后几小时抓的；没有发布时间就算不出 */
export function ageHours(w: Work): number | null {
  const s = w.snapshots[w.snapshots.length - 1];
  const pub = w.publishedAt ? Date.parse(w.publishedAt) : NaN;
  if (!s || Number.isNaN(pub)) return null;
  const h = (snapAt(s) - pub) / HOUR;
  return Number.isFinite(h) && h >= 0 ? h : null;
}

/**
 * 同龄「平时」（§8-9）：同平台别的作品里，找发出后同样时长（±max(6 小时, 25%)）抓到的那次快照，取播放中位数。
 * 够 3 条才算；不够 = null，调用方退回全量中位数并写明。
 */
export function sameAgeBaseline(rows: DataRow[], self: DataRow, platform: string, hours: number): number | null {
  const tol = Math.max(6, hours * 0.25);
  const vals: number[] = [];
  for (const r of rows) {
    if (r.id === self.id) continue;
    for (const w of r.works.filter((x) => x.platform === platform && x.publishedAt)) {
      const pub = Date.parse(w.publishedAt!);
      let best: { d: number; v: number } | null = null;
      for (const s of w.snapshots) {
        const v = viewsAt(s), d = Math.abs((snapAt(s) - pub) / HOUR - hours);
        if (v !== null && d <= tol && (!best || d < best.d)) best = { d, v };
      }
      if (best) vals.push(best.v);
    }
  }
  return vals.length >= MIN_SAMPLES ? median(vals) : null;
}

function perfLine(platform: string, views: number, baseline: number | null, basis: "same_age" | "all", age: number | null): PerfLine {
  const ratio = baseline ? views / baseline : null;
  return { platform, kind: "data", views, baseline, ratio, ...barOf(views, baseline), verdict: verdictOf(ratio), basis, ...(age !== null ? { ageHours: Math.round(age) } : {}) };
}

export function latestOf(data: DataPageData | null, now: number): Latest | null {
  if (!data) return null;
  const row = latestVideo(data.rows);
  if (!row) return null;
  const all = baselines(data.rows);
  const lines = platformLines(row, data.columns, all, now).map((l): PerfLine => {
    const w = row.works.find((x) => x.platform === l.platform);
    const s = w?.snapshots[w.snapshots.length - 1];
    const views = s ? viewsAt(s) : null;
    const age = w ? ageHours(w) : null;
    const same = views !== null && age !== null ? sameAgeBaseline(data.rows, row, l.platform, age) : null;
    // 能同龄比就同龄比（不满 24 小时也能比）；否则沿用原来的全量中位数，不满 24 小时的先不比
    if (views !== null && same !== null) return perfLine(l.platform, views, same, "same_age", age);
    if (l.kind === "pending") return { platform: l.platform, kind: "pending" };
    return perfLine(l.platform, l.views, l.baseline, "all", age);
  });
  return { rowId: row.id, contentId: row.contentId, title: row.contentTitle ?? row.title, day: row.day, after: daysAfter(row), lines };
}

// ── 管线一览 ───────────────────────────────────────────────────────────────

export interface Glance { col: PipelineColumn; n: number; hint: string; hot: boolean }

export function glanceOf(data: PipelineData): Glance[] {
  return PIPELINE_COLUMNS.map((col): Glance => {
    if (col === "选题") return { col, n: data.topics.length, hint: "", hot: false };
    const cards = data.themes.filter((t) => t.column === col);
    const n = cards.length;
    if (!n) return { col, n, hint: "", hot: false };
    if (col === "写稿") {
      const ready = cards.filter((t) => t.item.status === "draft_ready").length;
      return ready ? { col, n, hint: `${ready} 篇等你认`, hot: true } : { col, n, hint: "AI 在写", hot: false };
    }
    if (col === "录制" || col === "剪辑") {
      const you = cards.filter((t) => statusLine(t)?.tone === "you").length;
      if (you) return { col, n, hint: col === "剪辑" ? `${you} 条等你看` : `${you} 条要你处理`, hot: true };
      return { col, n, hint: col === "录制" ? "等你录 A-roll" : "在剪", hot: false };
    }
    const dests = cards.flatMap((t) => t.destinations.filter((d) => d.required || d.content_id));
    const ask = dests.filter((d) => d.state === "待你定" || d.state === "没发成").length;
    if (ask) return { col, n, hint: `${ask} 个去向等你${col === "待发布" ? "定" : "核对"}`, hot: true };
    const check = dests.filter((d) => d.state === "待核").length;
    if (check) return { col, n, hint: `${check} 个去向待核`, hot: false };
    return { col, n, hint: col === "全部发完" ? "" : col === "待发布" ? "等定时" : "", hot: false };
  });
}

// ── 让 AI 看看 ─────────────────────────────────────────────────────────────

/** 交出去之后卡上那一句：三种结果分开说（§8-11），打不开 / 剪贴板没写进去也照实说 */
export type AskOutcome = { tone: "ok" | "paste" | "fail"; text: string };
export function askOutcome(d: { host: string; label: string; opened: boolean; paste: boolean; open_error?: string }, copied: boolean): AskOutcome {
  if (d.host === "chief") return { tone: "ok", text: "已交给总编辑：右边对话框填好了，看一眼按发送" };
  if (!d.paste) return { tone: "ok", text: `已打开 ${d.label} 会话，指令已预填，按发送开始` };
  if (!copied) return { tone: "fail", text: `${d.label}${d.opened ? " 已打开，" : ""}但指令没能写进剪贴板` };
  if (d.open_error) return { tone: "paste", text: `${d.label} 没打开（${d.open_error}）。指令已复制，去 ${d.label} 里粘贴发送` };
  return { tone: "paste", text: d.opened ? `要你粘贴：${d.label} 已打开，指令已复制` : `要你粘贴：指令已复制，粘到 ${d.label} 里发出去` };
}

/** 点之前就知道交不出去：没接本机 AI 也没配模型钥匙 */
export function askBlocked(w: { writers: string[]; chief: boolean; error?: string } | null): string | null {
  if (!w) return null;
  if (w.error) return `读不出接了哪些 AI：${w.error}`;
  return w.writers.length || w.chief ? null : "没接本机 AI，也没配模型钥匙：先去设置接一个";
}

// ── 页头 ───────────────────────────────────────────────────────────────────

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
/** 「10 月 25 日 · 周日」（本机时区） */
export function dateEyebrow(now: Date): string {
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${WEEK[now.getDay()]}`;
}

/** 回流时间：「10-25 09:02」 */
export function shortTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
