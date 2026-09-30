/**
 * 「等你拍板」的前端模型（spec 2026-09-30-review-inbox §3、§4）：条目形状（与后端 /api/inbox 一致）、排序、
 * 行上的说法、下一件、撤回对应的动作、提醒合并。纯函数，渲染层只拿它用。
 */

export type InboxType =
  | "ask" | "ask_reported" | "cut_review" | "cover_pick" | "candidate" | "auto_attached" | "attach_check" | "inbox_file" | "sliver"
  | "register_blocked" | "publish_check" | "published_ask" | "publish_claim" | "draft" | "other";

export interface InboxAction {
  action: string;
  label: string;
  role: "primary" | "secondary" | "quiet";
  params?: Record<string, unknown>;
  note?: "optional" | "required";
  placeholder?: string;
}

export interface InboxItem {
  item_id: string;
  gen: string;
  type: InboxType;
  content_id: string | null;
  title: string;
  summary: string;
  waiting: { host: string; label: string } | null;
  agent_waiting: boolean;
  since: string;
  rank: number;
  actions: InboxAction[];
  blocked_reason?: string;
  detail: Record<string, unknown>;
}

export interface InboxView { items: InboxItem[]; count: number; agent_waiting: number; generated_at: string }

/** §3.2：先按档（有 agent 在等 → 挡住推进 → 发布相关 → 稿子 → 其他），同档按时间从早到晚 */
export function sortItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || a.item_id.localeCompare(b.item_id));
}

/** 行首缩略图的种类：封面 / 视频帧 / 文档 */
export function thumbKind(t: InboxType): "cover" | "video" | "doc" {
  if (t === "cover_pick") return "cover";
  if (t === "cut_review" || t === "sliver" || t === "inbox_file") return "video";
  return "doc";
}

/** 第二行：稿名 + 谁在等（§3.1） */
export function secondLine(item: InboxItem): string {
  const who = item.waiting ? `${item.waiting.label}在等` : "没人在等";
  return item.content_id ? `${item.title} · ${who}` : who;
}

/** 屏幕上不出现的术语（§4.1）：兜底把后端文案里漏掉的换成人话 */
export function plainWords(s: string): string {
  return s.replace(/A-roll/gi, "原片").replace(/B-roll/gi, "画面素材").replace(/\bv0*\d+\b/g, "这一组");
}

/** 处理完之后自动打开的下一件：列表里原位置的下一件，没有就上一件，都没有 = null */
export function nextAfter(items: InboxItem[], doneId: string, previous: InboxItem[]): InboxItem | null {
  const idx = previous.findIndex((i) => i.item_id === doneId);
  const rest = items.filter((i) => i.item_id !== doneId);
  if (!rest.length) return null;
  const after = previous.slice(idx + 1).map((p) => rest.find((r) => r.item_id === p.item_id)).find(Boolean);
  return after ?? rest[Math.min(Math.max(idx, 0), rest.length - 1)];
}

/** ↓ / ↑ 在条目间移动 */
export function step(items: InboxItem[], currentId: string | null, dir: 1 | -1): InboxItem | null {
  if (!items.length) return null;
  const idx = items.findIndex((i) => i.item_id === currentId);
  if (idx < 0) return items[dir === 1 ? 0 : items.length - 1];
  return items[Math.min(items.length - 1, Math.max(0, idx + dir))];
}

/**
 * 做完一件能不能撤回、撤回调哪个决定（10 秒内）。只有真有撤销决定的才给「撤回」：
 * 就用这版 / 用这组 → 撤销批准；已经发出去了 / 对，发了 → 纠正这个平台的发布槽。
 */
export function undoFor(item: InboxItem, action: string, result: Record<string, unknown>): { action: string; params: Record<string, unknown> } | null {
  const decision = result.decision as { id?: string } | undefined;
  if ((action === "approve_cut" || action === "pick_cover") && decision?.id) return { action: "revoke_approval", params: { decision_id: decision.id } };
  const m = /^(?:published|claim):r(\d+):(.+)$/.exec(item.item_id);
  if ((action === "i_published" || action === "confirm_receipt") && m) return { action: "correct_publish", params: { target_id: `slot:${m[1]}:${m[2]}` } };
  return null;
}

/** 做完之后底部提示的那一句（§4.2：这版定了 · 撤回 · 还有 2 件） */
export const DONE_TEXT: Record<string, string> = {
  approve_cut: "这版定了", pick_cover: "这组定了", reject_cut: "已经告诉剪辑了", reject_cover: "已经告诉做封面的了", retire_cover_group: "这组不要了",
  confirm_candidate: "记下了，就是它", reject_candidate: "记下了，不是它", answer_ask: "已经回复了", undo_ask_answer: "撤回了转述的回答",
  i_published: "记下了，已经发出去了", confirm_receipt: "记下了，发了", correct_publish: "记下了，没发", approve_script: "稿子定了", revise_script: "已经告诉写稿的了",
  publish_check_confirm: "记下了，没问题", publish_check_revise: "已经告诉发布的了", publish_check_override: "按你的原话重新检查了", waive_sliver: "这处放行了",
  waive_sliver_check: "这条不查了", ack: "记下了", nudge: "已经催了", assign: "挂上了", keep_attach: "记下了，就是它", reassign_aroll: "改挂好了", undo_auto_attach: "挪回去了",
};

// ---- 网页提醒（§9 第一条）：只提醒「有 agent 在等」和「挡住推进」，同一条稿 10 分钟内合并，同一件不重复 ----

export const COALESCE_MS = 10 * 60_000;

export interface NotifyState { notified: Set<string>; lastByContent: Map<string, number> }

export const newNotifyState = (): NotifyState => ({ notified: new Set(), lastByContent: new Map() });

/** 这一轮要弹哪几件（每条稿至多一件；已弹过的不再弹）。会改 state */
export function toNotify(items: InboxItem[], state: NotifyState, now: number): InboxItem[] {
  const out: InboxItem[] = [];
  for (const i of items) {
    if (!(i.agent_waiting || i.rank <= 1)) continue;
    const key = `${i.item_id}\u0000${i.gen}`;
    if (state.notified.has(key)) continue;
    state.notified.add(key);
    const group = i.content_id ?? i.item_id;
    const last = state.lastByContent.get(group);
    if (last !== undefined && now - last < COALESCE_MS) continue;
    if (out.some((o) => (o.content_id ?? o.item_id) === group)) continue;
    state.lastByContent.set(group, now);
    out.push(i);
  }
  return out;
}

/** 标签页标题：「(3) AutoCrew」；没事时就是「AutoCrew」 */
export const tabTitle = (n: number) => (n > 0 ? `(${n}) AutoCrew` : "AutoCrew");
