/**
 * 对话里拍板（spec 2026-10-06 chat-approval）：
 * - confirm：服务端按条目现状弹系统确认窗，创始人点了「确认」才走 `decideItem` 的 CAS 提交；
 * - send_back：只有「还要改…」（reject_cover / reject_cut），不弹窗，记成 agent 转述（chat-reported）。
 *
 * 信任边界（§Codex 1）：弹窗证明的是创始人 GUI 会话里的一次点击；能做 GUI 自动化或直接写资料库的 agent 仍能绕过，
 * 与交接确认、看板令牌同一档剩余风险。没有任何「已确认」参数：提交只发生在本文件里、弹窗结果之后。
 *
 * 流程（§Codex 8）：核条目 / 选择 / 字节 → 拿弹窗位 → 弹窗（不持锁）→ 文件归属锁里重核字节 → decideItem（锁内再核代次）。
 */
import { getDataDir } from "../../../storage/local-store.js";
import { withProvenance } from "../decision-provenance.js";
import { decideItem, fingerprint } from "../inbox-decide.js";
import { readInbox } from "../inbox-read.js";
import type { InboxItem } from "../inbox.js";
import { withFileOwnership } from "../mutex.js";
import { verifyFacts } from "./files.js";
import { runConfirmDialog } from "./dialog-loop.js";
import { claimRequest, payloadHash, priorRequest, releaseRequest, releaseSlot, takeSlot, writeRequest, isRequestId, type RequestRecord, type RequestState } from "./requests.js";
import { boardLink, chatItem, DIALOG_ACTIONS, requesterOf, SEND_BACK_ACTIONS, selectionOf, type DialogFacts, type Selection } from "./view.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export interface ChatDecideInput {
  item_id: string; gen: string; decision: string; group_id?: string; fact_id?: string;
  cover_text?: string; note?: string; founder_words: string; request_id?: string; host?: unknown; session?: unknown;
}

export async function listForChat(dataDir = getDataDir()): Promise<Result> {
  const view = await readInbox(dataDir);
  const items = await Promise.all(view.items.map((i) => chatItem(i, dataDir)));
  return { ok: true, count: items.length, items,
    next_action: "先把要定的那件事在对话里给创始人看（标题、事实、看板链接），听他说要怎么定；批准类用 confirm 弹窗，「还要改」用 send_back。chat_decidable:false 的给 board_link 让他去看板。" };
}

type Found = { ok: true; item: InboxItem; selection: Extract<Selection, { ok: true }> } | { ok: false; result: Result };

/** 条目还在、代次没变、这类事能在对话里定、选中对象明确（E6、E7、选择器） */
async function locate(input: ChatDecideInput, allowed: Readonly<Record<string, readonly string[]>>, dataDir: string): Promise<Found> {
  const item = (await readInbox(dataDir)).items.find((x) => x.item_id === input.item_id);
  if (!item) return { ok: false, result: fail("already_handled", "这件事已在别处处理（或已经关了），不用再定：重新 list 看现在的样子") };
  if (item.gen !== input.gen) return { ok: false, result: fail("stale", "这件事刚变过（比如来了新的一组），先把新的样子给创始人看一遍再定", { item: await chatItem(item, dataDir) }) };
  if (!(allowed[item.type] ?? []).includes(input.decision)) {
    const why = DIALOG_ACTIONS[item.type] || SEND_BACK_ACTIONS[item.type] ? `这件事在这里不能做「${input.decision}」` : "这类事只能在看板上定";
    return { ok: false, result: fail("not_chat_decidable", why, { board_link: boardLink(item) }) };
  }
  const selection = selectionOf(item, input.decision, { group_id: str(input.group_id) || undefined, fact_id: str(input.fact_id) || undefined });
  if (!selection.ok) return { ok: false, result: fail(selection.code, selection.error, { item: await chatItem(item, dataDir) }) };
  return { ok: true, item, selection };
}

/** 封面字：创始人在对话里说的（显式参数）> 这组自己的字 / 交接时定的字。服务端算一次，弹窗显示、提交原样用 */
function effectiveCoverText(item: InboxItem, decision: string, selection: Extract<Selection, { ok: true }>, explicit: unknown): string | null {
  if (decision !== "pick_cover") return null;
  if (typeof explicit === "string") return explicit.trim();
  const g = (item.detail.groups as Array<{ group_id: string; text: string }>).find((x) => x.group_id === selection.params.group_id);
  return (g?.text ?? "").trim();
}

function decisionRequest(input: ChatDecideInput, item: InboxItem, selection: Extract<Selection, { ok: true }>, extra: Result): Record<string, unknown> {
  // 全新的请求对象：不带 _host / _session（那是模型调用的标记，只用来认出发起方，见 requesterOf）
  return { item_id: item.item_id, gen: item.gen, action: input.decision, ...(item.content_id ? { content_id: item.content_id } : {}), ...selection.params, ...extra };
}

/** 「还要改…」：不弹窗；原话与要改的话都必填（E5），记成 agent 转述 */
export async function sendBack(input: ChatDecideInput, dataDir = getDataDir()): Promise<Result> {
  if (!str(input.founder_words)) return fail("founder_words_required", "带上创始人在对话里的原话（founder_words），照抄，不要改写");
  if (!str(input.note)) return fail("note_required", "写一句要改哪里（note），给做的人看");
  const found = await locate(input, SEND_BACK_ACTIONS, dataDir);
  if (!found.ok) return found.result;
  const req = decisionRequest(input, found.item, found.selection, { note: str(input.note) });
  const r = await withProvenance({ source: "chat-reported", founder_words: str(input.founder_words), requested_by: requesterOf(input.host, input.session) }, () => decideItem(req, dataDir));
  return r.ok === true ? { ...r, recorded_as: "chat-reported", next_action: "告诉创始人已经转给做的人；看板上这条会标「对话里转述」。" } : r;
}

async function finish(dataDir: string, rec: RequestRecord, state: RequestState, result: Result): Promise<Result> {
  await writeRequest(dataDir, { ...rec, state, result });
  return result;
}

/** 真要提交的那份决定（弹窗前定下，提交时原样用） */
const commitRequest = (f: DialogFacts, input: ChatDecideInput) => decisionRequest(input, f.item, f.selection, f.coverText === null ? {} : { cover_text: f.coverText });

/** 点了「确认」之后：锁里重核字节，再交 decideItem（它在锁里再核代次）；带对话来源 */
async function commit(f: DialogFacts, input: ChatDecideInput, dataDir: string): Promise<Result> {
  return withFileOwnership(async () => {
    const bytes = await verifyFacts(f.item.content_id ?? "", f.selection.factIds, dataDir);
    if (!bytes.ok) return fail(bytes.code, bytes.error);
    const req = commitRequest(f, input);
    return withProvenance({ source: "chat-dialog", founder_words: f.founderWords, requested_by: f.requester }, () => decideItem(req, dataDir));
  });
}

function validConfirm(input: ChatDecideInput): Result | null {
  if (!isRequestId(str(input.request_id))) return fail("invalid_params", "confirm 要带 request_id（1–100 位字母、数字、-、_），重试用同一个");
  if (!str(input.founder_words)) return fail("founder_words_required", "带上创始人在对话里的原话（founder_words），照抄；弹窗会显示给他核对");
  if (!str(input.item_id) || !str(input.gen) || !str(input.decision)) return fail("invalid_params", "confirm 要带 item_id、gen 和 decision（list 里给的）");
  return null;
}

/** confirm：弹窗确认后才提交（E1–E15） */
export async function confirmDecision(input: ChatDecideInput, dataDir = getDataDir()): Promise<Result> {
  const bad = validConfirm(input);
  if (bad) return bad;
  const requestId = str(input.request_id);
  // 先同步占住请求号（任何 await 之前）：同号并发的第二个调用直接 busy，不会各自过了查账再各弹一个窗
  if (!claimRequest(requestId)) return fail("dialog_busy", "同一个 request_id 的确认正在进行，等它出结果");
  try {
    return await confirmClaimed(input, requestId, dataDir);
  } finally {
    releaseRequest(requestId);
  }
}

async function confirmClaimed(input: ChatDecideInput, requestId: string, dataDir: string): Promise<Result> {
  const hash = payloadHash({ item_id: input.item_id, gen: input.gen, decision: input.decision, group_id: str(input.group_id), fact_id: str(input.fact_id),
    cover_text: typeof input.cover_text === "string" ? input.cover_text.trim() : null, founder_words: str(input.founder_words), requester: requesterOf(input.host, input.session) });
  const prior = await priorRequest(dataDir, requestId, hash);
  if (prior.kind === "replay") return prior.result;
  if (prior.kind === "conflict") return fail("request_conflict", "这个 request_id 已经用在另一件事 / 另一个决定上了：换一个新的");
  if (prior.kind === "busy") return fail("dialog_busy", "这次确认的弹窗还开着，等创始人点完");
  const found = await locate(input, DIALOG_ACTIONS, dataDir);
  if (!found.ok) return found.result;
  const { item, selection } = found;
  const bytes = await verifyFacts(item.content_id ?? "", selection.factIds, dataDir);
  if (!bytes.ok) return fail(bytes.code, bytes.error, { board_link: boardLink(item) });
  const facts: DialogFacts = { item, decision: input.decision, selection, coverText: effectiveCoverText(item, input.decision, selection, input.cover_text),
    founderWords: str(input.founder_words), requester: requesterOf(input.host, input.session), fileNames: bytes.files.map((x) => x.name) };
  if (!takeSlot(requestId)) return fail("dialog_busy", "Mac 上已经有一个确认窗开着（可能是别的会话发起的）：等创始人点完那个再来");
  try {
    return await dialogAndCommit(facts, input, { request_id: requestId, payload_hash: hash, state: "dialog_open", at: new Date().toISOString(),
      content_id: item.content_id, item_id: item.item_id, gen: item.gen, decision: input.decision, commit_fp: fingerprint(input.decision, commitRequest(facts, input)) }, dataDir);
  } finally {
    releaseSlot(requestId);
  }
}

async function dialogAndCommit(facts: DialogFacts, input: ChatDecideInput, rec: RequestRecord, dataDir: string): Promise<Result> {
  await writeRequest(dataDir, rec);
  const outcome = await runConfirmDialog(facts, dataDir);
  if (!outcome.ok) return finish(dataDir, rec, outcome.state, { ...outcome.result, board_link: boardLink(facts.item) });
  const r = await commit(facts, input, dataDir);
  if (r.ok !== true) {
    const fresh = (await readInbox(dataDir)).items.find((x) => x.item_id === facts.item.item_id);
    return finish(dataDir, rec, "refused", { ...r, error: `创始人点了确认，但${String(r.error ?? "提交没成")}；这次什么都没记`, ...(fresh ? { item: await chatItem(fresh, dataDir) } : {}) });
  }
  return finish(dataDir, rec, "committed", { ...r, status: "confirmed", recorded_as: "chat-dialog", next_action: "告诉创始人已经按他点的确认记下了。" });
}
