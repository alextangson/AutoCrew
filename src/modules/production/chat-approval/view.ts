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
import { draftFacts, sliverActions, sliverFacts, sliverSelection } from "./script-sliver-view.js";

/** 对话里能定的事与决定；其余类型（登记卡住、其他提案…）只在看板定 */
export const CHAT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  cover_pick: ["pick_cover", "retire_cover_group", "reject_cover"], cut_review: ["approve_cut", "reject_cut"], candidate: ["confirm_candidate", "reject_candidate"],
  ask: ["answer_ask", "ask_resend"],
  publish_check: ["publish_check_confirm", "publish_check_revise", "publish_check_override"],
  publish_claim: ["confirm_receipt", "correct_publish"], published_ask: ["i_published"],
  writing_rule: ["approve_rule", "reject_rule", "replace_rule"], playbook_change: ["approve_playbook", "reject_playbook"],
  sliver: ["waive_sliver_check", "waive_sliver", "reject_cut"], draft: ["approve_script", "revise_script"],
};

/** 库级条目：不挂在某篇稿的制作文档上（写作规则 spec 2026-10-10 §C、手册改动 spec 2026-10-13 §3） */
export const isLibraryItem = (item: InboxItem): boolean => item.type === "writing_rule" || item.type === "playbook_change";

/** 能在对话里定：类型在表里，且挂在一条稿上——库级条目例外（不一定来自某篇稿） */
export const chatDecidable = (item: InboxItem): boolean => Boolean(CHAT_ACTIONS[item.type]) && (Boolean(item.content_id) || isLibraryItem(item));

/** 这件事此刻在对话里能做的决定：请示只给条目自己现在有的（附件变过 → 只有「让它重发」） */
export function chatActionsOf(item: InboxItem): readonly string[] {
  const all = CHAT_ACTIONS[item.type] ?? [];
  if (item.type === "sliver") return sliverActions(item, all);
  return item.type === "ask" || item.type === "publish_check" ? all.filter((d) => item.actions.some((a) => a.action === d)) : all;
}
/** 要带一句「改哪里」的 */
export const NOTE_ACTIONS: ReadonlySet<string> = new Set(["reject_cover", "reject_cut", "publish_check_revise", "revise_script"]);

const ACTION_TEXT: Record<string, string> = {
  pick_cover: "用这组封面", retire_cover_group: "这组封面不要了（文件不删）", approve_cut: "成片就用这版",
  confirm_candidate: "对，这个文件就是这条的", reject_candidate: "不是，这个文件不是这条的",
  reject_cover: "封面还要改", reject_cut: "成片还要改",
  confirm_receipt: "对，发了", correct_publish: "没发", i_published: "发了（他给了作品链接就放 url，原样）",
  publish_check_confirm: "没问题（照这份计划发）", publish_check_revise: "还要改（note 写他要改的地方）", publish_check_override: "破例（只在被拦时；他的原话原样记下）",
  answer_ask: "按他选的那个选项回答（带 option_id，多说的话放 note）", ask_resend: "附件变过，让它重发请示",
  waive_sliver_check: "这条不查了（只在检查没跑成时有）", waive_sliver: "这处是故意的（带 sliver_key 点名哪一处）",
  approve_script: "稿子没问题", revise_script: "稿子还要改（note 写他要改的地方）",
  approve_playbook: "这份手册改动批了（生成新版本）", reject_playbook: "这份手册改动不要（同一段以后不再提）",
  approve_rule: "这条规则要（以后写稿都照它）", reject_rule: "这条不要（以后不再提）", replace_rule: "要，替换掉他点名的那条旧规则（带 target_rule_id）",
};

export interface Group { group_id: string; label: string; text: string; approved: boolean; "3:4": { fact_id: string } | null; "4:3": { fact_id: string } | null }
export interface Version { fact_id: string; label: string; approved: boolean; blocked_reason?: string }

export const groupsOf = (item: InboxItem) => (item.detail.groups as Group[] | undefined) ?? [];
export const versionsOf = (item: InboxItem) => (item.detail.versions as Version[] | undefined) ?? [];

export function boardLink(item: InboxItem): string {
  const base = `http://127.0.0.1:${pullDeps().benchPort}/`;
  if (item.type === "writing_rule") return `${base}#/calibration`;
  if (item.type === "playbook_change" || item.item_id === "playbook:error") return `${base}#/playbooks`;
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

function ruleFacts(item: InboxItem): Record<string, unknown> {
  const d = item.detail;
  return { rule_id: d.rule_id, rule: d.rule, scope: d.scope, founder_words: d.founder_words, conflicts_with: d.conflicts_with, active_rule_count: d.active_rule_count, rule_cap: d.rule_cap };
}

function playbookFacts(item: InboxItem): Record<string, unknown> {
  const d = item.detail;
  return { playbook: d.playbook, playbook_name: d.playbook_name, proposal_id: d.proposal_id, based_on: d.based_on, current: d.current, reason: d.reason, founder_words: d.founder_words, diff: d.diff };
}

function libraryFacts(item: InboxItem): Record<string, unknown> {
  return item.type === "writing_rule" ? ruleFacts(item) : playbookFacts(item);
}

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
  if (item.type === "publish_claim") return { platform: item.detail.platform, url: item.detail.url ?? null, item: item.detail.item ?? null, reporter: item.detail.reporter ?? null };
  if (item.type === "published_ask") return { platform: item.detail.platform };
  if (item.type === "sliver") return sliverFacts(item);
  if (item.type === "draft") return draftFacts(item);
  if (item.type === "publish_check") return { check_id: item.detail.check_id, platform: item.detail.platform, verdict: item.detail.verdict };
  if (item.type === "ask") {
    const d = item.detail;
    return { ask_id: d.ask_id, kind: d.kind, question: d.question, options: d.options, attachments_changed: d.attachments_changed === true };
  }
  return {};
}

/** list 里每件事：能不能在对话里定、能做哪些决定、要给创始人看的事实、看板深链 */
export async function chatItem(item: InboxItem, dataDir: string): Promise<Record<string, unknown>> {
  const decidable = chatDecidable(item);
  const doc = decidable && !isLibraryItem(item) ? await readProductionDocOrEmpty(item.content_id!, dataDir) : null;
  const decisions = chatActionsOf(item).map((d) => ({ decision: d, label: ACTION_TEXT[d], ...(NOTE_ACTIONS.has(d) ? { note: "required" } : {}) }));
  return { item_id: item.item_id, gen: item.gen, type: item.type, content_id: item.content_id, title: item.title, summary: item.summary,
    chat_decidable: decidable, ...(decidable ? { decisions, facts: isLibraryItem(item) ? libraryFacts(item) : factsView(item, doc!, dataDir) } : {}), board_link: boardLink(item) };
}

export type Selection = { ok: true; params: Record<string, string>; factIds: string[]; label: string } | { ok: false; code: string; error: string };
const bad = (code: string, error: string): Selection => ({ ok: false, code, error });

function pickOne<T>(list: T[], key: (x: T) => string, wanted: string, what: string): T | string {
  if (wanted) return list.find((x) => key(x) === wanted) ?? `这件事里没有这${what}，刷新再看`;
  return list.length === 1 ? list[0] : `这件事里有 ${list.length} ${what}：说清是哪${what}（带上${what === "组" ? " group_id" : " fact_id"}）`;
}

/** 选中的对象（E5 选择器）：有多组 / 多版时必须点名，不替创始人挑 */
export function selectionOf(item: InboxItem, decision: string, sel: { group_id?: string; fact_id?: string; option_id?: string; target_rule_id?: string; sliver_key?: string }): Selection {
  if (item.type === "playbook_change") return { ok: true, params: {}, factIds: [], label: String(item.detail.playbook_name ?? "") };
  if (item.type === "writing_rule") {
    if (decision !== "replace_rule") return { ok: true, params: {}, factIds: [], label: String(item.detail.rule ?? "") };
    if (!sel.target_rule_id) return bad("selector_required", "替换要说清换掉哪一条（带 target_rule_id，取生效规则的 id）；他没点名就先问他");
    return { ok: true, params: { target_rule_id: sel.target_rule_id }, factIds: [], label: String(item.detail.rule ?? "") };
  }
  if (item.type === "sliver") return sliverSelection(item, decision, sel.sliver_key);
  if (item.type === "draft") return { ok: true, params: {}, factIds: [], label: item.title };
  if (item.type === "ask") return askSelection(item, decision, sel.option_id);
  if (item.type === "publish_check" || item.type === "publish_claim" || item.type === "published_ask") return { ok: true, params: {}, factIds: [], label: String(item.detail.platform ?? "") };
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
