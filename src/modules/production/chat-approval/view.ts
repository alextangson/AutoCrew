/**
 * 对话里的「等你拍板」（spec 2026-10-06 chat-approval）：条目给 agent 看的样子、选哪一组 / 哪一版、弹窗文字。
 *
 * 弹窗文字只由服务端按条目当前的事实生成（E1）；agent 给的值只有会进决定的那几个（封面字）和创始人原话，原样显示（E2）。
 */
import path from "node:path";
import { readProductionDocOrEmpty } from "../../../storage/production-store.js";
import type { ProductionDoc } from "../../../storage/production-types.js";
import { hostLabel } from "../host-label.js";
import { KIND_NAME } from "../plain-reason.js";
import type { InboxItem } from "../inbox.js";
import { pullDeps } from "../../video/handoff/pull-deps.js";

/** 要弹窗确认的（改事实 / 批准）与只记一句话的（还要改…） */
export const DIALOG_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  cover_pick: ["pick_cover", "retire_cover_group"], cut_review: ["approve_cut"], candidate: ["confirm_candidate", "reject_candidate"],
};
export const SEND_BACK_ACTIONS: Readonly<Record<string, readonly string[]>> = { cover_pick: ["reject_cover"], cut_review: ["reject_cut"] };

const ACTION_TEXT: Record<string, string> = {
  pick_cover: "用这组封面", retire_cover_group: "这组封面不要了（文件不删）", approve_cut: "成片就用这版",
  confirm_candidate: "对，这个文件就是这条的", reject_candidate: "不是，这个文件不是这条的",
  reject_cover: "封面还要改", reject_cut: "成片还要改",
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

function factsView(item: InboxItem, doc: ProductionDoc): Record<string, unknown> {
  if (item.type === "cover_pick") {
    return { groups: groupsOf(item).map((g) => ({ group_id: g.group_id, label: g.label, cover_text: g.text, approved: g.approved,
      files: [nameOf(doc, g["3:4"]?.fact_id), nameOf(doc, g["4:3"]?.fact_id)].filter(Boolean) })), incomplete_note: item.detail.incomplete_note ?? null };
  }
  if (item.type === "cut_review") {
    return { versions: versionsOf(item).map((v) => ({ fact_id: v.fact_id, label: v.label, file: nameOf(doc, v.fact_id), approved: v.approved, ...(v.blocked_reason ? { blocked_reason: v.blocked_reason } : {}) })),
      ...(item.blocked_reason ? { blocked_reason: item.blocked_reason } : {}) };
  }
  if (item.type === "candidate") {
    const d = item.detail;
    return { fact_id: d.fact_id, kind: KIND_NAME[String(d.kind)] ?? d.kind, file: d.name ?? null, reason: d.reason ?? null };
  }
  return {};
}

/** list 里每件事：能不能在对话里定、能做哪些决定、要给创始人看的事实、看板深链 */
export async function chatItem(item: InboxItem, dataDir: string): Promise<Record<string, unknown>> {
  const decidable = Boolean(DIALOG_ACTIONS[item.type]);
  const doc = decidable && item.content_id ? await readProductionDocOrEmpty(item.content_id, dataDir) : null;
  const decisions = [...(DIALOG_ACTIONS[item.type] ?? []).map((d) => ({ decision: d, label: ACTION_TEXT[d], via: "confirm" })),
    ...(SEND_BACK_ACTIONS[item.type] ?? []).map((d) => ({ decision: d, label: ACTION_TEXT[d], via: "send_back" }))];
  return { item_id: item.item_id, gen: item.gen, type: item.type, content_id: item.content_id, title: item.title, summary: item.summary,
    chat_decidable: decidable, ...(decidable ? { decisions, facts: factsView(item, doc!) } : {}), board_link: boardLink(item) };
}

export type Selection = { ok: true; params: Record<string, string>; factIds: string[]; label: string } | { ok: false; code: string; error: string };
const bad = (code: string, error: string): Selection => ({ ok: false, code, error });

function pickOne<T>(list: T[], key: (x: T) => string, wanted: string, what: string): T | string {
  if (wanted) return list.find((x) => key(x) === wanted) ?? `这件事里没有这${what}，刷新再看`;
  return list.length === 1 ? list[0] : `这件事里有 ${list.length} ${what}：说清是哪${what}（带上${what === "组" ? " group_id" : " fact_id"}）`;
}

/** 选中的对象（E5 选择器）：有多组 / 多版时必须点名，不替创始人挑 */
export function selectionOf(item: InboxItem, decision: string, sel: { group_id?: string; fact_id?: string }): Selection {
  if (item.type === "cover_pick") {
    if (decision === "reject_cover") return { ok: true, params: {}, factIds: [], label: "还没定的那几组" };
    const g = pickOne(groupsOf(item), (x) => x.group_id, sel.group_id ?? "", "组");
    if (typeof g === "string") return bad(sel.group_id ? "stale" : "selector_required", g);
    return { ok: true, params: { group_id: g.group_id }, factIds: [g["3:4"]?.fact_id, g["4:3"]?.fact_id].filter((x): x is string => Boolean(x)), label: g.label };
  }
  if (item.type === "cut_review") {
    const v = pickOne(versionsOf(item), (x) => x.fact_id, sel.fact_id ?? "", "版");
    if (typeof v === "string") return bad(sel.fact_id ? "stale" : "selector_required", v);
    if (decision === "approve_cut" && v.blocked_reason) return bad("blocked", `这一版还不能通过：${v.blocked_reason}`);
    return { ok: true, params: { fact_id: v.fact_id }, factIds: decision === "approve_cut" ? [v.fact_id] : [], label: v.label };
  }
  const id = String(item.detail.fact_id ?? "");
  if (sel.fact_id && sel.fact_id !== id) return bad("stale", "这件事说的不是这个文件，刷新再看");
  return { ok: true, params: {}, factIds: item.detail.preview ? [id] : [], label: String(item.detail.name ?? "") };
}

export interface DialogFacts { item: InboxItem; decision: string; selection: Extract<Selection, { ok: true }>; coverText: string | null; founderWords: string; requester: string; fileNames: string[] }

/** 发起方：宿主名取自传输层（MCP 注入的 _host / _session），不取 agent 写的参数 */
export function requesterOf(host: unknown, session: unknown): string {
  const h = typeof host === "string" && host ? hostLabel(host) : "本机";
  const s = typeof session === "string" && session && session !== "unknown" ? `（会话 ${session.slice(0, 8)}）` : "";
  return `${h}${s}`;
}

function detailLines(f: DialogFacts): string[] {
  const { item, selection } = f;
  const files = f.fileNames.length ? [`文件：${f.fileNames.join("、")}`] : [];
  if (item.type === "cover_pick") return [`哪一组：${selection.label}`, ...files, ...(f.coverText === null ? [] : [`封面字：${f.coverText ? `「${f.coverText}」` : "（不加字）"}`])];
  if (item.type === "cut_review") return [`哪一版：${selection.label}`, ...files];
  return [`文件：${String(item.detail.name ?? "（没有文件名）")}`, `是什么：${KIND_NAME[String(item.detail.kind)] ?? String(item.detail.kind)}`, ...(item.detail.reason ? [`为什么找到它：${String(item.detail.reason)}`] : [])];
}

/** 确认窗正文：全部取自服务端此刻读到的条目 */
export function dialogText(f: DialogFacts, notice: string | null, needsView: boolean): string {
  return [...(notice ? [`刚才打不开：${notice}`, ""] : []), `${f.requester}请你确认：`, `稿件：${f.item.title}`, `要做的事：${ACTION_TEXT[f.decision]}`,
    ...detailLines(f), `你在对话里说的：「${f.founderWords}」`, ...(needsView ? ["", "成片要先点「查看」看过，才能确认。"] : [])].join("\n");
}
