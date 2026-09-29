/**
 * 看板页面模型（看板规格 A–E，纯函数）：六列、卡片排序与折叠、拖动规则、往回退的菜单、
 * 发布行文案、估时长。列归属由服务端按「我的内容」同一张表算好，这里不再推一遍。
 */
import { VIDEO_PLATFORMS, platformLabel } from "../lib";
import { clockLabel, durationText, relativeLabel } from "../time-format";

export const COLUMNS = ["选题", "写稿中", "待录制", "剪辑中", "待发布", "已发布"] as const;
export type BoardColumn = (typeof COLUMNS)[number];
export type ItemColumn = Exclude<BoardColumn, "选题">;

/** 列内先显示几张，其余「还有 N 条 ▾」（§4） */
export const VISIBLE_LIMIT = 8;
/** 已发布只留最近几条（与「我的内容」一致） */
export const PUBLISHED_LIMIT = 5;

/** 列头下面一行说明 */
export const COLUMN_HINT: Record<BoardColumn, string> = {
  选题: "雷达 · 收件箱 · 你建的",
  写稿中: "AI 在写 / 审 · 写完等你认稿",
  待录制: "按上一条语速估时长 · 点开看稿",
  剪辑中: "Codex 在剪",
  待发布: "成片、封面都过了",
  已发布: "按发布时间 · 更早的去数据页",
};

/** 空列只留一行说明（§3） */
export const EMPTY_NOTE: Record<BoardColumn, string> = {
  选题: "雷达找到的、你记下的想法会出现在这",
  写稿中: "点选题的「开始写」，稿子会出现在这",
  待录制: "你认过的稿会出现在这，等你录",
  剪辑中: "Codex 在剪的会出现在这",
  待发布: "成片和封面都过了会出现在这",
  已发布: "发出去的会出现在这",
};

export type PublicationState = "scheduled" | "overdue" | "public" | "reviewing" | "rejected" | "not_submitted" | "manual" | "unknown";
export interface PlatformPublication {
  platform: string;
  state: PublicationState;
  submitted: boolean;
  raw: string | null;
  review: string | null;
  time: string | null;
  reason: string | null;
  url: string | null;
  campaigns: string[];
  manual: { platform: string; at: string; url?: string } | null;
}
export type PublishRecord =
  | { kind: "none" }
  | { kind: "unreadable"; reason: string; platforms: PlatformPublication[] }
  | { kind: "ok"; platforms: PlatformPublication[] };

export interface BoardItem {
  id: string;
  title: string;
  platform: string | null;
  status: string;
  topicId: string | null;
  column: ItemColumn;
  createdAt: string;
  updatedAt: string;
  draftReadyAt: string | null;
  chars: number;
  finalDurationMs: number | null;
  handoffHash?: string | null;
  cover: { path: string; sha256: string } | null;
  publish: PublishRecord | null;
  publishTime: string | null;
  lastError: string | null;
  blockedReason: string | null;
}

export interface BoardTopic {
  id: string;
  title: string;
  source: string | null;
  link?: string | null;
  score: number | null;
  createdAt: string;
  renewedAt: string | null;
}

/** 本体对账报告（服务端 /api/board 的 ontology，spec 2026-09-29 §4.1）：未启用时的「要挪」清单与逐条失败 */
export interface OntologyMove { id: string; title: string; from: string | null; to: string | null; rule: string | null; evidence: string[] }
export interface OntologyState {
  enabled: boolean;
  report: { at: string; enabled: boolean; moves: OntologyMove[]; errors: Array<{ id: string; title: string; error: string }>; warnings: string[] } | null;
}

export interface BoardData { items: BoardItem[]; topics: BoardTopic[]; wordsPerMinute: number | null; ontology?: OntologyState }

/** 看板顶部的本体提示：未启用且有要挪的卡 → 「要挪 N 张卡」；对账失败逐条可见；什么都没有 → null */
export function ontologyNotice(o: OntologyState | undefined): { moves: OntologyMove[]; errors: number; text: string } | null {
  const r = o?.report;
  if (!o || !r) return null;
  const moves = o.enabled ? [] : r.moves;
  const errors = r.errors.length;
  if (!moves.length && !errors) return null;
  const parts = [moves.length ? `本体对账：要挪 ${moves.length} 张卡，看一下` : "", errors ? `${errors} 条对账失败` : ""].filter(Boolean);
  return { moves, errors, text: parts.join("；") };
}

export type Card = { kind: "topic"; topic: BoardTopic } | { kind: "item"; item: BoardItem };

const time = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : -Infinity; };

/** 来源标签（§8）：雷达写具体源；收件箱；其余一律「你建的」，不编造是哪个会话 */
export function topicSourceLabel(source: string | null | undefined): string {
  if (source?.startsWith("radar:")) {
    const name = source.slice(6).trim();
    return name ? `雷达 · ${name}` : "雷达";
  }
  if (source?.startsWith("inbox:")) return "收件箱";
  return "你建的";
}

function sortTopics(topics: BoardTopic[]): BoardTopic[] {
  return [...topics].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || time(b.renewedAt ?? b.createdAt) - time(a.renewedAt ?? a.createdAt));
}

function itemKey(item: BoardItem): number {
  if (item.column === "已发布") return time(item.publishTime);
  if (item.column === "待录制") return time(item.draftReadyAt ?? item.updatedAt);
  return time(item.updatedAt);
}

/** 六列的卡；已发布按发布时间倒序只留最近 5 条（未来的定时排最上面，§19） */
export function boardCards(data: BoardData): Record<BoardColumn, Card[]> {
  const out = Object.fromEntries(COLUMNS.map((c) => [c, [] as Card[]])) as Record<BoardColumn, Card[]>;
  out.选题 = sortTopics(data.topics).map((topic) => ({ kind: "topic", topic }));
  const sorted = [...data.items].sort((a, b) => itemKey(b) - itemKey(a) || a.id.localeCompare(b.id));
  for (const item of sorted) out[item.column].push({ kind: "item", item });
  out.已发布 = out.已发布.slice(0, PUBLISHED_LIMIT);
  return out;
}

/** 列内显示哪些：展开了全给，否则前 8 张 + 剩余条数 */
export function visibleCards(cards: Card[], expanded: boolean): { shown: Card[]; hidden: number } {
  if (expanded || cards.length <= VISIBLE_LIMIT) return { shown: cards, hidden: 0 };
  return { shown: cards.slice(0, VISIBLE_LIMIT), hidden: cards.length - VISIBLE_LIMIT };
}

const isVideo = (platform: string | null) => VIDEO_PLATFORMS.has(platform ?? "");

/** 状态落在哪列：与服务端 my-content-plan.columnOf 同一张表（往回拖时对「⋯」退路的目标列） */
export function statusColumn(status: string, video: boolean): ItemColumn | null {
  switch (status) {
    case "drafting": case "needs_evidence": case "reviewing": case "revision": case "draft_ready": return "写稿中";
    case "approved": return video ? "待录制" : "待发布";
    case "editing": case "cover_pending": return "剪辑中";
    case "publish_ready": case "publishing": return "待发布";
    case "published": return "已发布";
    default: return null;
  }
}

export type DropAction =
  | { kind: "none" }
  | { kind: "start" }
  | { kind: "approve" }
  | { kind: "open-handoff" }
  | { kind: "open-final" }
  | { kind: "publish" }
  | { kind: "back"; move: BackMove }
  | { kind: "refuse"; reason: string };

export type DragCard = Pick<BoardItem, "status" | "platform" | "column" | "publish">;

/** 拖动规则（纯函数，dragover 时也用）：from 列 + 被拖的卡（选题卡传 null）→ 该做什么，或为什么不行 */
export function dropAction(from: BoardColumn, item: DragCard | null, to: BoardColumn): DropAction {
  if (from === to) return { kind: "none" };
  if (from === "选题" || !item) return to === "写稿中" ? { kind: "start" } : { kind: "refuse", reason: "选题先拖到「写稿中」开始写" };
  if (COLUMNS.indexOf(to) < COLUMNS.indexOf(from)) return backDrop(item, to);
  return forwardDrop(from, item, to);
}

function backDrop(item: DragCard, to: BoardColumn): DropAction {
  const video = isVideo(item.platform);
  const move = backMoves(item).find((m) => statusColumn(m.target, video) === to);
  if (move) return { kind: "back", move };
  return { kind: "refuse", reason: backMoves(item).length ? `这张卡退不到「${to}」，看卡片上的「⋯」` : "这张卡不能往回退" };
}

function forwardDrop(from: BoardColumn, item: DragCard, to: BoardColumn): DropAction {
  const video = isVideo(item.platform);
  switch (from) {
    case "写稿中":
      if (item.status !== "draft_ready") return { kind: "refuse", reason: "AI 还在写，写完再认" };
      if (to === (video ? "待录制" : "待发布")) return { kind: "approve" };
      return { kind: "refuse", reason: video ? "先认稿，再录制：拖到「待录制」" : "先认稿：拖到「待发布」" };
    case "待录制":
      return to === "剪辑中" ? { kind: "open-handoff" } : { kind: "refuse", reason: "要先交剪辑" };
    case "剪辑中":
      return to === "待发布" ? { kind: "open-final" } : { kind: "refuse", reason: "成片、封面通过了才到待发布" };
    case "待发布":
      return to === "已发布" ? { kind: "publish" } : { kind: "refuse", reason: "这一步拖不了" };
    default:
      return { kind: "refuse", reason: "这一步拖不了" };
  }
}

/** 拖放后给人的一句话（打开工作台的两种） */
export const HANDOFF_NOTE = "交剪辑要 A-roll、工作台四项决定、出处映射齐了由 Codex 自接；已打开工作台";
export const FINAL_NOTE = "成片、封面在这里点通过后由 Codex 登记，卡片会自动进待发布";

/** revoke = 撤回交接：走服务端真正的撤回（作废代次、还原片、放认领），不是普通状态流转 */
export interface BackMove { label: string; target: string; title: string; body: string; revoke?: true }

/** 卡片「⋯」里的往回退（§15）：只走状态机本来就允许的那条退路，写明会发生什么 */
export function backMoves(item: Pick<BoardItem, "status" | "column" | "publish" | "platform">): BackMove[] {
  switch (item.status) {
    case "draft_ready":
      return [{ label: "退回重写", target: "drafting", title: "退回重写？", body: "稿子回到「在写」，改完要重新写完、你认过，才能再录。" }];
    case "approved":
      return [{ label: "退回写稿中", target: "reviewing", title: "退回写稿中？", body: "稿子回到审稿，审过才能再录、再交剪辑。" }];
    case "editing":
    case "cover_pending":
      return item.status === "editing" ? [{ label: "撤回交接", target: "draft_ready", revoke: true, title: "撤回交接？",
        body: "交接会被撤回：Codex 手上这一代作废，剪到一半的活停下。稿子回到「写稿中」等你认稿，认过、重录后要在 Codex 里重新说「剪这条」。" }] : [];
    case "publish_ready":
      return [{ label: "退回待录制", target: "approved", title: "退回待录制（重录）？",
        body: "这条回到「待录制」。已登记的成片留在历史里，重录后要重新交接剪辑、重新挑封面。" }];
    case "published":
      // 视频稿的阶段门不放 published → publish_ready，别给一条必败的退路
      if (isVideo(item.platform)) return [];
      if (item.publish && item.publish.kind !== "none" && item.publish.platforms.some((p) => p.submitted && !p.manual)) return [];
      return [{ label: "退回待发布", target: "publish_ready", title: "退回待发布？", body: "这条标回「待发布」，发布时间清掉。平台上已经发出去的不会被撤下。" }];
    default:
      return [];
  }
}

export type Tone = "ok" | "muted" | "red";
export interface PublishLine { text: string; tone: Tone }

const REVIEW_TEXT: Record<string, string> = { reviewing: "审核中", approved: "审核通过", pending: "待审核" };

function reviewText(review: string | null): string {
  if (!review) return "";
  return ` · ${REVIEW_TEXT[review] ?? `审核：${review}`}`;
}

/** 一个平台一行（§18–§22）：没投的不标红；定时过了写「应已公开」；不认识的写原值 */
/** headTime = 卡片顶上已写的发布时间；与它相同就不在每行重复 */
export function publishLine(p: PlatformPublication, now: number = Date.now(), headTime: string | null = null): PublishLine {
  switch (p.state) {
    case "scheduled": {
      const same = headTime !== null && p.time !== null && Date.parse(headTime) === Date.parse(p.time);
      return { text: `定时${same ? "" : ` ${clockLabel(p.time, now)}`}${reviewText(p.review)}`, tone: "ok" };
    }
    case "overdue": return { text: "应已公开（等数据回流确认）", tone: "ok" };
    case "public": return { text: p.time ? `已公开 · ${relativeLabel(p.time, now)}` : "已公开", tone: "ok" };
    case "reviewing": return { text: `已提交${reviewText(p.review) || " · 审核中"}`, tone: "ok" };
    case "rejected": return { text: `没通过${p.reason ? `：${p.reason}` : ""}`, tone: "red" };
    case "manual": return { text: `你手动发的 · ${relativeLabel(p.time, now)}`, tone: "ok" };
    case "not_submitted": return { text: "还没发", tone: "muted" };
    default: return { text: `状态：${p.raw ?? "（空）"}`, tone: "muted" };
  }
}

/** 卡片顶上的发布时间：「10月2日 18:00 · 定时」 */
export function publishHeadline(item: BoardItem, now: number = Date.now()): string | null {
  if (!item.publishTime) return null;
  const future = Date.parse(item.publishTime) > now;
  return `${clockLabel(item.publishTime, now)}${future ? " · 定时" : ""}`;
}

export function platformName(p: string): string { return platformLabel(p); }

/** 估时长（§29）：「约 7.5 分钟」；没有语速或没字就不显示 */
export function estimateText(chars: number, wpm: number | null): string | null {
  if (!wpm || wpm <= 0 || chars <= 0) return null;
  const minutes = Math.max(0.5, Math.round((chars / wpm) * 2) / 2);
  return `约 ${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} 分钟`;
}

/** 卡片副标题 */
export function itemMeta(item: BoardItem, wpm: number | null, now: number = Date.now()): string {
  const parts: string[] = [];
  if (item.column === "写稿中" && item.status === "draft_ready") parts.push(`写完 ${relativeLabel(item.draftReadyAt ?? item.updatedAt, now)}`);
  else if (item.column === "写稿中") parts.push(item.status === "needs_evidence" ? "缺证据" : item.status === "reviewing" ? "在审" : "在写", `更新 ${relativeLabel(item.updatedAt, now)}`);
  if (item.column === "待录制") {
    const est = estimateText(item.chars, wpm);
    if (est) parts.push(est);
    parts.push(`定稿 ${relativeLabel(item.draftReadyAt ?? item.updatedAt, now)}`);
  }
  if (item.column === "剪辑中") parts.push(item.status === "cover_pending" ? "等挑封面" : "Codex 在剪", `更新 ${relativeLabel(item.updatedAt, now)}`);
  if (item.column === "待发布" || item.column === "已发布") {
    if (item.finalDurationMs) parts.push(durationText(item.finalDurationMs));
    const days = item.publishTime ? Math.ceil((Date.parse(item.publishTime) - now) / 86_400_000) : 0;
    if (item.column === "已发布" && days > 0) parts.push(`还有 ${days} 天公开`);
  }
  return parts.join(" · ");
}
