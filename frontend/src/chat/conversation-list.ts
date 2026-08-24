/**
 * 会话列表的展示口径（纯函数，好测）。
 *
 * 后端 ConversationMeta 一直带着 turns/updatedAt，切换器却只显示了标题——
 * 结果就是一列长得差不多的短语，看不出哪条是刚才那条。这里把「几轮 · 多久前」补回去，
 * 并按自然日分组。
 *
 * 两条防呆：坏时间戳（手改过的 meta.json）不许渲染成「NaN 分钟前」，
 * 未来时间（机器时钟漂移/跨时区拷贝的数据）按「刚刚」算，不出现「-3 小时前」。
 */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  turns?: number;
  /** 会话归属的稿件（软绑定）；旧会话没有，永远不参与自动匹配 */
  contentId?: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 坏时间戳一律回空串——调用方据此只显示轮数，不显示时间 */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  if (diff < MINUTE) return "刚刚"; // 含 diff<0（时钟漂移）
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 「6轮 · 2 小时前」；缺哪一半就只留另一半，不留孤零零的分隔点 */
export function conversationHint(c: ConversationSummary, now: number): string {
  const rel = relativeTime(c.updatedAt, now);
  const turns = typeof c.turns === "number" && c.turns > 0 ? `${c.turns}轮` : "";
  return [turns, rel].filter(Boolean).join(" · ");
}

/**
 * 这篇稿件名下最近聊过的那段（软绑定的「最近」= updatedAt 最大）。
 * 坏时间戳当作最旧，但绝不因此漏掉唯一一条候选——全坏时返回排在最前的那条。
 */
export function findConversationForContent(
  list: ConversationSummary[],
  contentId: string,
): ConversationSummary | undefined {
  if (!contentId) return undefined;
  let best: ConversationSummary | undefined;
  let bestTs = -Infinity;
  for (const c of list) {
    if (c.contentId !== contentId) continue;
    const t = Date.parse(c.updatedAt);
    const ts = Number.isFinite(t) ? t : -Infinity;
    if (!best || ts > bestTs) {
      best = c;
      bestTs = ts;
    }
  }
  return best;
}

/**
 * 打开某篇稿件时右栏该怎么动（切换判定的唯一事实源，ChatDock 只接线）：
 * stay = 当前这段已经是这篇稿件的，别打断；load = 切到它名下最近那段；
 * fresh = 这篇稿件还没聊过，进新会话空状态（首条消息发出时才建会话并绑定）。
 */
export type ConversationSwitch =
  | { action: "stay" }
  | { action: "load"; id: string }
  | { action: "fresh" };

export function decideConversationSwitch(params: {
  list: ConversationSummary[];
  contentId: string;
  activeId?: string;
}): ConversationSwitch {
  const { list, contentId, activeId } = params;
  if (!contentId) return { action: "stay" }; // 非稿件视图（看板/增长面板）不动会话
  const active = activeId ? list.find((c) => c.id === activeId) : undefined;
  if (active?.contentId === contentId) return { action: "stay" };
  const hit = findConversationForContent(list, contentId);
  return hit ? { action: "load", id: hit.id } : { action: "fresh" };
}

/** 本地日历日的 00:00（分组按自然日，不按 24 小时滚动窗口——「昨天」得是昨天） */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface ConversationGroup {
  name: string;
  items: ConversationSummary[];
}

/**
 * 今天 / 昨天 / 最近 7 天 / 更早。坏时间戳落「更早」（排最后，不打断正常的时间轴）。
 * 组内顺序沿用服务端给的（updatedAt 倒序），不重排。
 */
export function conversationGroups(list: ConversationSummary[], now: number): ConversationGroup[] {
  const today = startOfDay(now);
  const buckets: ConversationGroup[] = [
    { name: "今天", items: [] },
    { name: "昨天", items: [] },
    { name: "最近 7 天", items: [] },
    { name: "更早", items: [] },
  ];
  for (const c of list) {
    const t = Date.parse(c.updatedAt);
    if (!Number.isFinite(t)) {
      buckets[3].items.push(c);
      continue;
    }
    const day = startOfDay(t);
    if (day >= today) buckets[0].items.push(c); // 未来时间也算今天
    else if (day >= today - DAY) buckets[1].items.push(c);
    else if (day > today - 7 * DAY) buckets[2].items.push(c);
    else buckets[3].items.push(c);
  }
  return buckets.filter((b) => b.items.length > 0);
}
