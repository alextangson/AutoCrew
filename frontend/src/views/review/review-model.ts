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

/** 行首缩略图的种类：封面图 / 视频帧 / 字幕 / 文档。「稿」只给文档类，封面和成片永远有图（2a 真实数据验收） */
export function thumbKind(item: Pick<InboxItem, "type" | "detail">): "cover" | "video" | "srt" | "doc" {
  const t = item.type, kind = item.detail.kind;
  if (t === "cover_pick" || (t === "candidate" && kind === "cover")) return "cover";
  if (t === "cut_review" || t === "sliver" || t === "inbox_file" || t === "auto_attached" || t === "attach_check" || (t === "candidate" && (kind === "cut" || kind === "aroll"))) return "video";
  if (t === "candidate" && kind === "srt") return "srt";
  return "doc";
}

/** 预览用的事实 id：封面取 3:4，成片取最新一版，候选取它自己 */
export function previewFact(item: Pick<InboxItem, "type" | "detail">): string | null {
  const d = item.detail;
  if (item.type === "cover_pick") return (d.groups as Array<{ "3:4": { fact_id: string } | null }> | undefined)?.[0]?.["3:4"]?.fact_id ?? null;
  if (item.type === "cut_review") return (d.versions as Array<{ fact_id: string }> | undefined)?.[0]?.fact_id ?? null;
  if (item.type === "sliver") return String(d.cut_fact_id ?? "") || null;
  if ((item.type === "candidate" || item.type === "auto_attached" || item.type === "attach_check") && d.preview) return String(d.fact_id);
  return null;
}

// ---- 行：同一条稿同种候选合成一行、稿子合成一行（只是显示；决定仍按每件自己的 item_id + gen） ----

export interface Row { key: string; items: InboxItem[]; title: string; sub: string; since: string; rank: number; agent_waiting: boolean }

const MEASURE: Record<string, string> = { cover: "张", srt: "份", cut: "段", aroll: "段" };
const KIND: Record<string, string> = { cover: "封面", srt: "字幕", cut: "成片", aroll: "原片" };

export function groupRows(items: InboxItem[]): Row[] {
  const byKey = new Map<string, InboxItem[]>();
  const keyOf = (i: InboxItem) => (i.type === "candidate" ? `group:cand:${i.content_id}:${String(i.detail.kind)}` : i.type === "draft" ? "group:draft" : i.item_id);
  for (const i of items) byKey.set(keyOf(i), [...(byKey.get(keyOf(i)) ?? []), i]);
  const rows: Row[] = [];
  for (const [key, group] of byKey) {
    const first = group[0];
    const single = group.length === 1;
    let title = plainWords(first.summary);
    if (!single && first.type === "candidate") { const k = String(first.detail.kind); title = `找到 ${group.length} ${MEASURE[k] ?? "个"}${KIND[k] ?? "文件"}，看看是不是这条的`; }
    if (!single && first.type === "draft") title = `${group.length} 篇稿子写好了，过一眼`;
    const sub = single ? secondLine(first) : first.type === "draft" ? group.map((g) => g.title).slice(0, 3).join("、") + (group.length > 3 ? " …" : "") : secondLine(first);
    rows.push({ key: single ? first.item_id : key, items: group, title, sub, since: group.map((g) => g.since).sort()[0], rank: Math.min(...group.map((g) => g.rank)), agent_waiting: group.some((g) => g.agent_waiting) });
  }
  return rows.sort((a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
}

/** 做完一件后下一个打开的行：原来那行还有剩就留在那行，否则原位置的下一行 */
export function nextRowAfter(rows: Row[], doneKey: string, previous: Row[]): Row | null {
  const same = rows.find((r) => r.key === doneKey);
  if (same) return same;
  const idx = previous.findIndex((r) => r.key === doneKey);
  const after = previous.slice(idx + 1).map((p) => rows.find((r) => r.key === p.key)).find(Boolean);
  return after ?? rows[Math.min(Math.max(idx, 0), rows.length - 1)] ?? null;
}

export function stepRow(rows: Row[], currentKey: string | null, dir: 1 | -1): Row | null {
  if (!rows.length) return null;
  const idx = rows.findIndex((r) => r.key === currentKey);
  if (idx < 0) return rows[dir === 1 ? 0 : rows.length - 1];
  return rows[Math.min(rows.length - 1, Math.max(0, idx + dir))];
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
  const m = /^(?:published|claim):[^:]+:r(\d+):(.+)$/.exec(item.item_id);
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

/** 页面打开时已有的事：只把这几件记成「提醒过」，不开 10 分钟合并窗口（同一条稿紧接着来的新事照样提醒） */
export function seedNotified(items: InboxItem[], state: NotifyState): void {
  for (const i of items) state.notified.add(`${i.item_id}\u0000${i.gen}`);
}

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
/** stale：列表没刷新成（连不上 / 登录过期）——保留上次的件数、加问号「(2?) AutoCrew」 */
export const tabTitle = (n: number, stale = false) => (n > 0 ? `(${n}${stale ? "?" : ""}) AutoCrew` : stale ? "(?) AutoCrew" : "AutoCrew");

/** 列表停住时列表头的那句：登录过期 → 刷新页面；其他 → 连不上、停在几点几分 */
export function staleLine(error: string, lastOkAt: number | null, expired: boolean): string {
  if (expired) return "登录过期，刷新页面";
  const t = lastOkAt ? new Date(lastOkAt) : null;
  const hm = t ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` : "";
  return hm ? `连不上 AutoCrew，列表停在 ${hm}` : `连不上 AutoCrew：${error}`;
}
