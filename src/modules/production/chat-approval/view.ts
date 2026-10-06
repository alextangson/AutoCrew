/**
 * 对话里的「等你拍板」（spec 2026-10-06 chat-approval，修订：对话原话直接定）：条目给 agent 看的样子、选哪一组 / 哪一版。
 */
import path from "node:path";
import { readProductionDocOrEmpty } from "../../../storage/production-store.js";
import type { ProductionDoc } from "../../../storage/production-types.js";
import { hostLabel } from "../host-label.js";
import { KIND_NAME } from "../plain-reason.js";
import type { InboxItem } from "../inbox.js";
import { pullDeps } from "../../video/handoff/pull-deps.js";
import { factPath } from "./files.js";

/** 对话里能定的事与决定；其余类型（发布、收件箱文件、请示、闪帧…）只在看板定 */
export const CHAT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  cover_pick: ["pick_cover", "retire_cover_group", "reject_cover"], cut_review: ["approve_cut", "reject_cut"], candidate: ["confirm_candidate", "reject_candidate"],
  ask: ["answer_ask", "ask_resend"],
};

/** 这件事此刻在对话里能做的决定：请示只给条目自己现在有的（附件变过 → 只有「让它重发」） */
export function chatActionsOf(item: InboxItem): readonly string[] {
  const all = CHAT_ACTIONS[item.type] ?? [];
  return item.type === "ask" ? all.filter((d) => item.actions.some((a) => a.action === d)) : all;
}
/** 要带一句「改哪里」的 */
export const NOTE_ACTIONS: ReadonlySet<string> = new Set(["reject_cover", "reject_cut"]);

const ACTION_TEXT: Record<string, string> = {
  pick_cover: "用这组封面", retire_cover_group: "这组封面不要了（文件不删）", approve_cut: "成片就用这版",
  confirm_candidate: "对，这个文件就是这条的", reject_candidate: "不是，这个文件不是这条的",
  reject_cover: "封面还要改", reject_cut: "成片还要改",
  answer_ask: "按他选的那个选项回答（带 option_id，多说的话放 note）", ask_resend: "附件变过，让它重发请示",
};

export interface Group { group_id: string; label: string; text: string; approved: boolean; "3:4": { fact_id: string } | null; "4:3": { fact_id: string } | null }
export interface Version { fact_id: string; label: string; approved: boolean; blocked_reason?: string }

export const groupsOf = (item: InboxItem) => (item.detail.groups as Group[] | undefined) ?? [];
export const versionsOf = (item: InboxItem) => (item.detail.versions as Version[] | undefined) ?? [];

export function boardLink(item: InboxItem): string {
  const base = `http://127.0.0.1:${pullDeps().benchPort}/`;
  return item.content_id ? `${base}#/board?inbox=${encodeURIComponent(item.content_id)}&types=${encodeURIComponent(item.type)}` : `${base}#/inbox`;
}

const nameOf = (doc: ProductionDoc, factId: string | undefined) => {
  const p = doc.facts.find((f) => f.id === factId)?.path;
  return p ? path.basename(p) : null;
};

/** 成片的绝对路径：给创始人点开看片（只读，取自事实记录） */
const pathOf = (doc: ProductionDoc, contentId: string, factId: string, dataDir: string) => {
  const f = doc.facts.find((x) => x.id === factId);
  return f?.path ? factPath(contentId, f, dataDir) : null;
};

function factsView(item: InboxItem, doc: ProductionDoc, dataDir: string): Record<string, unknown> {
  if (item.type === "cover_pick") {
    return { groups: groupsOf(item).map((g) => ({ group_id: g.group_id, label: g.label, cover_text: g.text, approved: g.approved,
      files: [nameOf(doc, g["3:4"]?.fact_id), nameOf(doc, g["4:3"]?.fact_id)].filter(Boolean) })), incomplete_note: item.detail.incomplete_note ?? null };
  }
  if (item.type === "cut_review") {
    return { versions: versionsOf(item).map((v) => ({ fact_id: v.fact_id, label: v.label, file: nameOf(doc, v.fact_id), path: pathOf(doc, item.content_id!, v.fact_id, dataDir), approved: v.approved, ...(v.blocked_reason ? { blocked_reason: v.blocked_reason } : {}) })),
      ...(item.blocked_reason ? { blocked_reason: item.blocked_reason } : {}) };
  }
  if (item.type === "candidate") {
    const d = item.detail;
    return { fact_id: d.fact_id, kind: KIND_NAME[String(d.kind)] ?? d.kind, file: d.name ?? null, reason: d.reason ?? null };
  }
  if (item.type === "ask") {
    const d = item.detail;
    return { ask_id: d.ask_id, kind: d.kind, question: d.question, options: d.options, attachments_changed: d.attachments_changed === true };
  }
  return {};
}

/** list 里每件事：能不能在对话里定、能做哪些决定、要给创始人看的事实、看板深链 */
export async function chatItem(item: InboxItem, dataDir: string): Promise<Record<string, unknown>> {
  const decidable = Boolean(CHAT_ACTIONS[item.type]) && Boolean(item.content_id);
  const doc = decidable ? await readProductionDocOrEmpty(item.content_id!, dataDir) : null;
  const decisions = chatActionsOf(item).map((d) => ({ decision: d, label: ACTION_TEXT[d], ...(NOTE_ACTIONS.has(d) ? { note: "required" } : {}) }));
  return { item_id: item.item_id, gen: item.gen, type: item.type, content_id: item.content_id, title: item.title, summary: item.summary,
    chat_decidable: decidable, ...(decidable ? { decisions, facts: factsView(item, doc!, dataDir) } : {}), board_link: boardLink(item) };
}

export type Selection = { ok: true; params: Record<string, string>; factIds: string[]; label: string } | { ok: false; code: string; error: string };
const bad = (code: string, error: string): Selection => ({ ok: false, code, error });

function pickOne<T>(list: T[], key: (x: T) => string, wanted: string, what: string): T | string {
  if (wanted) return list.find((x) => key(x) === wanted) ?? `这件事里没有这${what}，刷新再看`;
  return list.length === 1 ? list[0] : `这件事里有 ${list.length} ${what}：说清是哪${what}（带上${what === "组" ? " group_id" : " fact_id"}）`;
}

/** 选中的对象（E5 选择器）：有多组 / 多版时必须点名，不替创始人挑 */
export function selectionOf(item: InboxItem, decision: string, sel: { group_id?: string; fact_id?: string; option_id?: string }): Selection {
  if (item.type === "ask") return askSelection(item, decision, sel.option_id);
  if (item.type === "cover_pick") {
    // 「还要改」与网页同一范围：打回所有还没定的组，不点名；核的是这几组的全部文件
    if (decision === "reject_cover") {
      const open = groupsOf(item).filter((x) => !x.approved);
      return { ok: true, params: {}, factIds: open.flatMap((x) => [x["3:4"]?.fact_id, x["4:3"]?.fact_id]).filter((x): x is string => Boolean(x)), label: "还没定的那几组" };
    }
    const g = pickOne(groupsOf(item), (x) => x.group_id, sel.group_id ?? "", "组");
    if (typeof g === "string") return bad(sel.group_id ? "stale" : "selector_required", g);
    return { ok: true, params: { group_id: g.group_id }, factIds: [g["3:4"]?.fact_id, g["4:3"]?.fact_id].filter((x): x is string => Boolean(x)), label: g.label };
  }
  if (item.type === "cut_review") {
    const v = pickOne(versionsOf(item), (x) => x.fact_id, sel.fact_id ?? "", "版");
    if (typeof v === "string") return bad(sel.fact_id ? "stale" : "selector_required", v);
    if (decision === "approve_cut" && v.blocked_reason) return bad("blocked", `这一版还不能通过：${v.blocked_reason}`);
    return { ok: true, params: { fact_id: v.fact_id }, factIds: [v.fact_id], label: v.label };
  }
  const id = String(item.detail.fact_id ?? "");
  if (sel.fact_id && sel.fact_id !== id) return bad("stale", "这件事说的不是这个文件，刷新再看");
  return { ok: true, params: {}, factIds: item.detail.preview ? [id] : [], label: String(item.detail.name ?? "") };
}

/** 发起方：宿主名取自传输层（MCP 注入的 _host / _session），不取 agent 写的参数 */
export function requesterOf(host: unknown, session: unknown): string {
  const h = typeof host === "string" && host ? hostLabel(host) : "本机";
  const s = typeof session === "string" && session && session !== "unknown" ? `（会话 ${session.slice(0, 8)}）` : "";
  return `${h}${s}`;
}

/** 请示：答要落到唯一一个选项上——多个选项没点名 → selector_required，绝不替他挑 */
function askSelection(item: InboxItem, decision: string, optionId: string | undefined): Selection {
  if (decision !== "answer_ask") return { ok: true, params: {}, factIds: [], label: "让它重发" };
  const options = (item.detail.options as Array<{ id: string; label: string }> | undefined) ?? [];
  const o = pickOne(options, (x) => x.id, optionId ?? "", "个选项");
  if (typeof o === "string") return bad(optionId ? "stale" : "selector_required", optionId ? o : `这件请示有 ${options.length} 个选项：他的话对不上唯一一个就先问他，别猜（带上 option_id）`);
  return { ok: true, params: { option_id: o.id }, factIds: [], label: o.label };
}
