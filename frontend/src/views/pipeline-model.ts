/**
 * 内容管线页面模型（管线重规划 §2、§8，纯函数）：一个主题一张卡。服务端 /api/pipeline 已把分组、列、去向状态算好，
 * 这里只管：列的进度图、去向条每一格的颜色、卡上只显示例外、空列收成竖条、拖动落到旧看板的哪一列。
 */
import type { BoardColumn, BoardData, BoardItem, BoardTopic } from "./board-columns";
import type { TargetAction } from "./publish-targets";
import { handoffLine } from "./handoff-line";

export const PIPELINE_COLUMNS = ["选题", "写稿", "录制", "剪辑", "待发布", "发布中", "全部发完"] as const;
export type PipelineColumn = (typeof PIPELINE_COLUMNS)[number];
export type ThemeColumn = Exclude<PipelineColumn, "选题">;

/** 待核 = 定时过点、还没核到公开（旧看板「应已公开，等核对」）：琥珀色提示，不是没发成 */
export type DestState = "没开始" | "在做" | "待你定" | "已定时" | "待核" | "已发" | "没发成";
export interface DestRow {
  platform: string;
  state: DestState;
  detail: string;
  at?: string;
  content_id: string | null;
  tag?: string;
  required: boolean;
  skipped?: { by: string; founder_words: string; at: string };
  paused?: boolean;
  history?: boolean;
  actions?: TargetAction[];
  slot_id?: string;
  fact_id?: string;
  url?: string;
}
export interface ReshootRecord {
  round_ended: number; round: number; at: string; founder_words: string; via: "board" | "chat"; host?: string;
  published: Array<{ platform: string; content_id: string | null }>;
  to_cancel: Array<{ platform: string; content_id: string | null; at?: string }>;
}
export interface ThemeCard {
  id: string;
  kind: "video" | "text" | "orphan";
  title: string;
  column: ThemeColumn;
  item: BoardItem;
  children: BoardItem[];
  destinations: DestRow[];
  sent: number;
  required: number;
  exceptions: string[];
  plan: { required: string[]; skipped: Array<{ platform: string; by: string; founder_words: string; at: string }>; persisted: boolean };
  reshoot: ReshootRecord | null;
  date: string | null;
}
export interface TopicSupply { today: number; target: number; refills: number; short: boolean; reason: string | null }
export interface PipelineData extends BoardData { themes: ThemeCard[]; planErrors: Array<{ id: string; error: string }>; topicSupply?: TopicSupply }

/** 4–5 星 = 钉住 */
export const isPinned = (t: Pick<BoardTopic, "stars">) => typeof t.stars === "number" && t.stars >= 4;

/** 选题列排序：钉住的（星多的在前）→ 本周片单 → 雷达分 → 最近动过的 */
export function sortPipelineTopics(topics: BoardTopic[]): BoardTopic[] {
  const time = (s: string | null | undefined) => (s ? new Date(s).getTime() || 0 : 0);
  return [...topics].sort((a, b) =>
    Number(isPinned(b)) - Number(isPinned(a)) || (isPinned(a) && isPinned(b) ? (b.stars ?? 0) - (a.stars ?? 0) : 0)
    || Number(!!b.inSlate) - Number(!!a.inSlate) || (b.score ?? -1) - (a.score ?? -1) || time(b.renewedAt ?? b.createdAt) - time(a.renewedAt ?? a.createdAt));
}

/** 卡右下角：钉住 / N 天后进回收站 / 不老化（3 星、捞回过）；本周片单不写 */
export function topicAgeLine(t: Pick<BoardTopic, "stars" | "agingDaysLeft" | "inSlate">): { kind: "pin" | "clock"; text: string } | null {
  if (isPinned(t)) return { kind: "pin", text: "已钉住" };
  if (typeof t.agingDaysLeft === "number") return { kind: "clock", text: t.agingDaysLeft <= 0 ? "今天进回收站" : `${t.agingDaysLeft} 天后进回收站` };
  return null;
}

/** 列头的进度图：0 = 虚线圈，1 = 实心勾（mock 的 ST0–ST6） */
export const COLUMN_PROGRESS: Record<PipelineColumn, number> = { 选题: 0, 写稿: 0.2, 录制: 0.4, 剪辑: 0.6, 待发布: 0.75, 发布中: 0.9, 全部发完: 1 };

export const DEST_LABEL: Record<string, string> = {
  douyin: "抖音", wechat_video: "视频号", xiaohongshu: "小红书", bilibili: "B站", wechat_mp: "公众号", youtube: "YouTube", x: "X",
};
export const destLabel = (p: string) => DEST_LABEL[p] ?? p;

/** 去向条的一格：已发 = 墨色、已定时 = 灰、在做 = 浅灰、待你定 / 没发成 = 橙、没开始 = 空框 */
export type MeterTone = "done" | "sched" | "check" | "wip" | "hot" | "none";
const TONE: Record<DestState, MeterTone> = { 已发: "done", 已定时: "sched", 待核: "check", 在做: "wip", 待你定: "hot", 没发成: "hot", 没开始: "none" };
export const meterTone = (s: DestState): MeterTone => TONE[s];

/** 去向条只画要发的（不出的不画、历史不画） */
export function meterRows(card: Pick<ThemeCard, "destinations">): DestRow[] {
  return card.destinations.filter((d) => d.required);
}

/** 行内状态的小图标 */
export type StateIcon = "done" | "sched" | "check" | "wip" | "you" | "fail" | "none" | "skip";
export function stateIcon(d: Pick<DestRow, "state" | "skipped" | "required">): StateIcon {
  if (d.skipped && d.state !== "已发") return "skip";
  return ({ 已发: "done", 已定时: "sched", 待核: "check", 在做: "wip", 待你定: "you", 没发成: "fail", 没开始: "none" } as const)[d.state];
}

/** 展开前的卡只显示例外（mock：「YouTube 英文版在做」「X 没开始」只在发布段出现；前几列不出去向） */
export function showMeter(card: Pick<ThemeCard, "column">): boolean {
  return card.column === "待发布" || card.column === "发布中" || card.column === "全部发完";
}

/** 不出的那一行脚注：「YouTube、X 不出 · 你定的」 */
export function skippedLine(card: Pick<ThemeCard, "plan">): string | null {
  const s = card.plan.skipped;
  if (!s.length) return null;
  const who = s.every((x) => x.by === "你在看板上") ? "你定的" : "你在对话里定的";
  return `${s.map((x) => destLabel(x.platform)).join("、")} 不出 · ${who}`;
}

/** 前几列的状态行（mock：「第 2 稿写好了，等你认」橙；「Claude 在写」灰；「稿已定 · 等你录 A-roll」虚线） */
export function statusLine(card: ThemeCard): { text: string; tone: "you" | "wip" | "none" } | null {
  const it = card.item;
  if (card.reshoot && (card.column === "录制")) return { text: "要重拍 · 等你录新的 A-roll", tone: "none" };
  if (it.status === "draft_ready") return { text: "稿子写好了，等你认", tone: "you" };
  if (it.alerts?.length) return { text: it.alerts[0], tone: "you" };
  if (card.column === "写稿") {
    const h = handoffLine(it.handoff);
    return h ? { text: h.text, tone: h.stale ? "you" : "wip" } : { text: it.status === "needs_evidence" ? "缺证据，等补" : "在写", tone: "wip" };
  }
  if (card.column === "录制") {
    const suspect = (it.badges ?? []).find((b) => b.includes("A-roll") || b.includes("原片"));
    return suspect ? { text: suspect, tone: "you" } : { text: "稿已定 · 等你录 A-roll", tone: "none" };
  }
  if (card.column === "剪辑") {
    const ask = (it.missing ?? []).find((m) => m.includes("待你") || m.startsWith("你说"));
    return ask ? { text: it.reason || ask, tone: "you" } : { text: it.reason || "在剪", tone: "wip" };
  }
  return null;
}

/** 空列收成竖条（mock 的「待发布 0」）；选题列永远展开 */
export function collapsedColumns(themes: ThemeCard[]): Set<ThemeColumn> {
  const out = new Set<ThemeColumn>();
  for (const c of PIPELINE_COLUMNS) if (c !== "选题" && !themes.some((t) => t.column === c)) out.add(c);
  return out;
}

/** 每列先显示几张；全部发完按日期倒序 */
export const PIPELINE_VISIBLE = 5;
export function columnCards(themes: ThemeCard[], col: ThemeColumn): ThemeCard[] {
  const list = themes.filter((t) => t.column === col);
  const key = (t: ThemeCard) => t.date ?? t.item.updatedAt;
  return list.sort((a, b) => key(b).localeCompare(key(a)));
}

/** 拖动：新列落到旧看板的哪一列（拖 = 真动作，规则仍是 board-columns.dropAction） */
export const DROP_TARGET: Record<PipelineColumn, BoardColumn> = {
  选题: "选题", 写稿: "写稿中", 录制: "待录制", 剪辑: "剪辑中", 待发布: "待发布", 发布中: "已发布", 全部发完: "已发布",
};

/** 「要你做的」按主题分组显示：同一主题的行挨在一起，组的顺序按组里最靠前的一行；每行原样保留 */
export function groupByTheme<R extends { items: Array<{ theme_id?: string; theme_title?: string; content_id: string | null }> }>(rows: R[]): Array<{ theme: { id: string; title: string } | null; rows: R[] }> {
  const groups: Array<{ theme: { id: string; title: string } | null; rows: R[] }> = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const first = r.items[0];
    const id = first?.theme_id ?? null;
    const key = id ?? `__none__`;
    if (!at.has(key)) { at.set(key, groups.length); groups.push({ theme: id ? { id, title: first.theme_title ?? "" } : null, rows: [] }); }
    groups[at.get(key)!].rows.push(r);
  }
  return groups;
}

/** 卡右下角的日期：MM-DD（北京时间） */
export function mmdd(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t + 8 * 3600_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 「不出」看发布状态：要发、还没动（没开始 / 在做），不看平台槽上有没有通用动作 */
export function canSkipRow(card: Pick<ThemeCard, "kind">, r: Pick<DestRow, "required" | "state">): boolean {
  return card.kind === "video" && r.required && (r.state === "没开始" || r.state === "在做");
}

/** 「重拍」看本轮有没有素材：剪辑及之后的列 = 本轮已有原片 / 成片事实；不看这一轮是不是重拍开出来的（可以再重拍） */
const RESHOOT_COLUMNS: ReadonlySet<string> = new Set(["剪辑", "待发布", "发布中", "全部发完"]);
export function canReshoot(card: Pick<ThemeCard, "kind" | "column" | "item">): boolean {
  return card.kind === "video" && Boolean(card.item.active) && RESHOOT_COLUMNS.has(card.column);
}
