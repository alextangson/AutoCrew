/**
 * 主题分组（首页与管线重规划 §8-1/2/3）：只读投影，纯函数。
 *
 * 父 = 源视频稿；子 = `derivedFrom.contentId` 指向它的稿（反向索引；不信 siblings 数组，不按标题猜）。
 * 纯图文稿、找不到父的孤儿派生稿各自单独成卡。稿件 id 与编辑页链接不变（卡上带原来的看板条目）。
 *
 * 列：写稿 → 录制 → 剪辑 → 待发布 → 发布中 → 全部发完（选题列由选题给，不在这里）。
 * 父稿没到「待发布 / 已发布」之前，卡就停在父稿所在的列——派生稿单独发了也不挪（去向小标照样显示已发）。
 */
import type { BoardItem } from "../../desktop/board-data.js";
import type { Content } from "../../storage/local-store.js";
import type { ArticlePublishState } from "../wechat-article/publish-state.js";
import {
  DEST_LABEL, DESTINATIONS, EN_VIDEO, HOT, SENT, ZH_VIDEO, fromArticle, fromTarget, isDestination, mmdd, notStarted,
  type DestRow, type Destination, type PreReady,
} from "./destinations.js";
import type { DestinationPlan, ReshootRecord } from "./plan.js";

export const THEME_COLUMNS = ["写稿", "录制", "剪辑", "待发布", "发布中", "全部发完"] as const;
export type ThemeColumn = (typeof THEME_COLUMNS)[number];

export interface ThemeCard {
  /** 主题 id = 父稿 id（孤儿 / 纯图文 = 自己） */
  id: string;
  kind: "video" | "text" | "orphan";
  title: string;
  column: ThemeColumn;
  /** 父稿（孤儿 / 纯图文 = 自己）在看板上的条目：原来的卡片动作、拖动都按它 */
  item: BoardItem;
  /** 派生稿条目（公众号文章、英文版） */
  children: BoardItem[];
  destinations: DestRow[];
  /** 要发的去向里已发 / 要发的去向总数（不出的不算） */
  sent: number;
  required: number;
  /** 卡上只显示例外：待你定、没发成、等新成片、没定去向 */
  exceptions: string[];
  /** 计划：要发的平台、被标了不出的平台；persisted=false = 还是按当前勾选的默认 */
  plan: { required: Destination[]; skipped: Array<{ platform: Destination; by: string; founder_words: string; at: string }>; persisted: boolean };
  /** 本轮的重拍记录（已定时要你去撤的、已发保留的） */
  reshoot: ReshootRecord | null;
  /** 卡右下角的日期 */
  date: string | null;
}

export interface ThemeInput {
  items: BoardItem[];
  contents: Array<Pick<Content, "id" | "derivedFrom" | "platform">>;
  plans: Map<string, { plan: DestinationPlan; persisted: boolean }>;
  /** 公众号文章的发布状态；读坏了给 Error（照实标红，不当成没发） */
  articles: Map<string, ArticlePublishState | Error>;
  now?: Date;
}

const BEFORE_PUBLISH: Record<string, ThemeColumn> = { 写稿中: "写稿", 待录制: "录制", 剪辑中: "剪辑" };

function preReady(item: BoardItem): PreReady {
  const ready = item.column === "待发布" || item.column === "已发布";
  const waitingFounder = item.status === "draft_ready";
  return { ready, waitingFounder, reason: waitingFounder ? "等你认稿" : item.column === "写稿中" ? "在写" : item.column === "待录制" ? "等录制" : item.column === "剪辑中" ? "在剪" : item.reason };
}

/** 一条稿自己承载的去向行（父视频：中文视频平台；英文版：YouTube / X；公众号文章：公众号） */
function rowsOf(item: BoardItem, kind: "parent" | "en" | "article" | "text", input: ThemeInput): Array<Omit<DestRow, "required">> {
  const pre = preReady(item);
  if (kind === "article" || (kind === "text" && item.platform === "wechat_mp")) {
    const st = input.articles.get(item.id);
    if (st instanceof Error) return [{ platform: "wechat_mp", state: "没发成", detail: st.message, content_id: item.id }];
    const base = st ?? { superseded: [], attempts: [] };
    return [{ platform: "wechat_mp", ...fromArticle(base, pre, item.id, input.now) }];
  }
  if (kind === "text") {
    if (!item.platform || !isDestination(item.platform)) return [];
    const done = item.column === "已发布";
    return [{ platform: item.platform, state: done ? "已发" : pre.ready ? "待你定" : pre.waitingFounder ? "待你定" : "在做", detail: done ? "已发" : pre.ready ? "可以发了" : pre.reason, content_id: item.id, ...(done ? { at: mmdd(item.publishTime) } : {}) }];
  }
  const allow = kind === "parent" ? ZH_VIDEO : EN_VIDEO;
  // 父视频还在写稿 / 等认稿：平台行只是「没开始」，等你认稿由卡的状态行说，不在每个平台上重复
  const rowPre = kind === "parent" ? { ...pre, waitingFounder: false } : pre;
  return (item.targets ?? []).filter((t) => allow.has(t.platform) && isDestination(t.platform)).map((t) => {
    const r = fromTarget(t, rowPre, item.id);
    // 英文版还没到能发：稿已经开了，是「在做」不是「没开始」
    const fixed = kind === "en" && r.state === "没开始" ? { ...r, state: "在做" as const } : r;
    return { platform: t.platform as Destination, ...fixed };
  });
}

/** 同一去向有两条稿：都列，加区分 */
function labelDuplicates(rows: DestRow[]): DestRow[] {
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.platform, (count.get(r.platform) ?? 0) + 1);
  const seen = new Map<string, number>();
  return rows.map((r) => {
    if ((count.get(r.platform) ?? 0) < 2) return r;
    const n = (seen.get(r.platform) ?? 0) + 1;
    seen.set(r.platform, n);
    return { ...r, tag: `第 ${n} 篇` };
  });
}

/** 本轮还有效的重拍：重拍开的那一轮还是当前轮，且父稿还没回到能发 */
function activeReshoot(plan: DestinationPlan | undefined, item: BoardItem): ReshootRecord | null {
  const last = plan?.reshoots.at(-1);
  if (!last) return null;
  return item.round === null || item.round === last.round ? last : null;
}

function destinationsFor(parent: BoardItem, children: Array<{ item: BoardItem; kind: "en" | "article" }>, view: { plan: DestinationPlan } | undefined, input: ThemeInput, reshoot: ReshootRecord | null): DestRow[] {
  const plan = view?.plan;
  const entry = (p: Destination) => plan?.destinations[p];
  const parentReady = parent.column === "待发布" || parent.column === "已发布";
  const raw: Array<Omit<DestRow, "required">> = [...rowsOf(parent, "parent", input)];
  for (const c of children) {
    const rows = rowsOf(c.item, c.kind, input);
    // 派生去向暂停：重拍后父稿还没回到能发，或英文版 / 文章的源成片换了
    const paused = (reshoot && !parentReady) || c.item.derivedStale;
    raw.push(...rows.map((r) => (paused && !SENT.has(r.state) ? { ...r, state: "在做" as const, detail: "等新成片", paused: true } : r)));
  }
  // 计划里有、还没有对应稿 / 平台槽的去向
  for (const p of DESTINATIONS) {
    if (entry(p)?.required && !raw.some((r) => r.platform === p)) {
      const blank = notStarted(p);
      raw.push(ZH_VIDEO.has(p) ? { ...blank, content_id: parent.id, detail: preReady(parent).ready ? "可以发了" : preReady(parent).reason, state: preReady(parent).ready ? "待你定" : "没开始" } : blank);
    }
  }
  const rows: DestRow[] = raw.map((r) => {
    const e = entry(r.platform);
    const skipped = e && !e.required && e.by === "founder" ? { by: e.via === "chat" ? `对话里${e.host ? `（${e.host}）` : ""}` : "你在看板上", founder_words: e.founder_words ?? "", at: e.at } : undefined;
    const required = Boolean(e?.required);
    return { ...r, required, ...(skipped ? { skipped } : {}), ...(!required && r.state === "已发" ? { history: true } : {}) };
  });
  // 计划外、没发过、也不是被标不出的派生稿行照样显示（稿存在），但不算进要发
  return labelDuplicates(rows.sort((a, b) => DESTINATIONS.indexOf(a.platform) - DESTINATIONS.indexOf(b.platform)));
}

function columnOf(item: BoardItem, rows: DestRow[], planned: number): ThemeColumn {
  const early = BEFORE_PUBLISH[item.column];
  if (early) return early;
  const required = rows.filter((r) => r.required);
  const anySent = rows.some((r) => SENT.has(r.state));
  // 没定去向：不能说「全部发完」
  if (planned === 0) return anySent ? "发布中" : "待发布";
  // 要发的都确认已发（或全部被标了不出）
  if (required.every((r) => r.state === "已发")) return "全部发完";
  return anySent ? "发布中" : "待发布";
}

function exceptionsOf(rows: DestRow[], planned: number, skippedAll: boolean): string[] {
  const out: string[] = [];
  if (planned === 0 && !skippedAll) out.push("还没定发哪里");
  for (const r of rows) {
    if (r.paused) out.push(`${DEST_LABEL[r.platform]}${r.tag ? ` ${r.tag}` : ""} 等新成片`);
    else if ((r.required || r.content_id) && HOT.has(r.state)) out.push(`${DEST_LABEL[r.platform]}${r.tag ? ` ${r.tag}` : ""} ${r.detail}`);
  }
  return out;
}

function card(id: string, kind: ThemeCard["kind"], item: BoardItem, children: Array<{ item: BoardItem; kind: "en" | "article" }>, input: ThemeInput): ThemeCard {
  const view = kind === "video" ? input.plans.get(id) : undefined;
  const reshoot = activeReshoot(view?.plan, item);
  const rows = kind === "video" ? destinationsFor(item, children, view, input, reshoot)
    : rowsOf(item, kind === "orphan" ? (item.platform === "wechat_mp" ? "article" : "en") : "text", input).map((r) => ({ ...r, required: true }));
  const plannedEntries = kind === "video" ? Object.entries(view?.plan.destinations ?? {}) : rows.map((r) => [r.platform, { required: true }] as const);
  const required = rows.filter((r) => r.required);
  const planned = required.length;
  const skipped = kind === "video" ? Object.entries(view?.plan.destinations ?? {}).filter(([, e]) => e && !e.required).map(([p, e]) => ({ platform: p as Destination, by: e!.via === "chat" ? "对话里" : "你在看板上", founder_words: e!.founder_words ?? "", at: e!.at })) : [];
  const skippedAll = plannedEntries.length > 0 && planned === 0;
  const column = skippedAll && !BEFORE_PUBLISH[item.column] ? "全部发完" : columnOf(item, rows, planned);
  return {
    id, kind, title: item.title, column, item, children: children.map((c) => c.item), destinations: rows,
    sent: required.filter((r) => r.state === "已发").length, required: planned,
    exceptions: exceptionsOf(rows, planned, skippedAll),
    plan: { required: required.map((r) => r.platform).filter((p, i, a) => a.indexOf(p) === i), skipped, persisted: view?.persisted ?? true },
    reshoot, date: item.publishTime ?? item.updatedAt ?? null,
  };
}

export function groupThemes(input: ThemeInput): ThemeCard[] {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const derivedFrom = new Map(input.contents.map((c) => [c.id, c.derivedFrom]));
  // 反向索引：父 id → 派生稿
  const kids = new Map<string, Array<{ item: BoardItem; kind: "en" | "article" }>>();
  const orphans: BoardItem[] = [];
  for (const item of input.items) {
    const from = derivedFrom.get(item.id);
    if (!from) continue;
    const parent = byId.get(from.contentId);
    const parentDerived = parent ? derivedFrom.get(parent.id) : undefined;
    if (!parent || parentDerived) { orphans.push(item); continue; }
    const list = kids.get(parent.id) ?? [];
    list.push({ item, kind: from.kind === "wechat_article" ? "article" : "en" });
    kids.set(parent.id, list);
  }
  const cards: ThemeCard[] = [];
  for (const item of input.items) {
    if (derivedFrom.get(item.id)) continue;
    const video = item.platform !== null && (ZH_VIDEO.has(item.platform) || item.targets.length > 0) && !EN_VIDEO.has(item.platform);
    cards.push(card(item.id, video ? "video" : "text", item, kids.get(item.id) ?? [], input));
  }
  for (const o of orphans) cards.push(card(o.id, "orphan", o, [], input));
  return cards;
}
