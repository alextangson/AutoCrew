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
