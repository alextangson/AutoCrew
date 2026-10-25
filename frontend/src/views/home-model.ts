/**
 * 首页「今天」的纯计算（管线重规划 §1、§5、§8-9，第 3 期）。
 * - 账号格：只写今天真有的东西（回流健康），粉丝 / 播放留给第 4 期的账号快照，不编数字。
 * - 刚发那条：复用数据页的 latestVideo / platformLines / baselines（同一把「平时」尺子）。
 * - 管线一览：/api/pipeline 的列计数 + 一句短提示。
 */
import { pullHint, type PullPlatformStatus } from "../pull-lib";
import { baselines, latestVideo, platformLines, daysAfter } from "./data-answers";
import type { DataPageData } from "./data-lib";
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

export function latestOf(data: DataPageData | null, now: number): Latest | null {
  if (!data) return null;
  const row = latestVideo(data.rows);
  if (!row) return null;
  const lines = platformLines(row, data.columns, baselines(data.rows), now).map((l): PerfLine => {
    if (l.kind === "pending") return { platform: l.platform, kind: "pending" };
    return { platform: l.platform, kind: "data", views: l.views, baseline: l.baseline, ratio: l.ratio, ...barOf(l.views, l.baseline), verdict: verdictOf(l.ratio) };
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
