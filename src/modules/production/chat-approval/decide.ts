/**
 * 对话里拍板（spec 2026-10-06 chat-approval，修订「drop the dialog — chat words decide」）：
 * 创始人在对话里说的原话直接定；不弹窗。创始人知情放弃了弹窗的防伪：模型能写对话，这里分辨不出。
 * 保留的保证：item_id + gen + 选中对象绑定、多组 / 多版必须点名、代次变了拒并给新样子、已定过 → 已在别处处理、
 * request_id 幂等（绑请求内容）、提交前现算选中文件的 sha、封面字服务端算一次原样提交。
 * 每个决定都带原话（founder_words，必填）、发起方，来源记 `chat`。
 */
import { getDataDir } from "../../../storage/local-store.js";
import { withProvenance } from "../decision-provenance.js";
import { founderDecision } from "../decisions.js";
import { decideItem, fingerprint, type DecideDeps } from "../inbox-decide.js";
import { checkFilesUnsettled, verifyCheck } from "../../publish/review-gate/check.js";
import { presentItem } from "./present.js";
import { urlMismatch } from "./post-publish-view.js";
import { readInbox } from "../inbox-read.js";
import type { InboxItem } from "../inbox.js";
import { withFileOwnership } from "../mutex.js";
import { verifyFacts } from "./files.js";
import { claimRequest, isRequestId, payloadHash, readRequest, recoverRequest, releaseRequest, writeRequest, type Binding, type RequestRecord } from "./requests.js";
import { boardLink, CHAT_ACTIONS, chatActionsOf, chatItem, NOTE_ACTIONS, requesterOf, selectionOf, type Selection } from "./view.js";

type Result = Record<string, unknown>;
type Picked = Extract<Selection, { ok: true }>;
const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export interface ChatDecideInput {
  /** 被拒时把「现在的样子」的文件放进会话文件夹；不进请求指纹 */
  preview_dir?: string;
  /** i_published：创始人给的作品链接（原样记） */
  url?: string;
  item_id: string; gen: string; decision: string; group_id?: string; fact_id?: string; option_id?: string; content_id?: string; decision_id?: string;
  cover_text?: string; note?: string; founder_words: string; request_id?: string; host?: unknown; session?: unknown;
}

/** 现在的样子：和 list 一样带 brief 与预览（改了什么、文件都能直接再给他看） */
const shownNow = (item: InboxItem, input: ChatDecideInput, dataDir: string) => presentItem(item, dataDir, input.preview_dir);

type Found = { ok: true; item: InboxItem; selection: Picked } | { ok: false; result: Result };

/** 条目还在、代次没变、这类事能在对话里定、选中对象明确（E6、E7、选择器） */
async function locate(input: ChatDecideInput, dataDir: string): Promise<Found> {
  const item = (await readInbox(dataDir)).items.find((x) => x.item_id === input.item_id);
  if (!item) return { ok: false, result: fail("already_handled", "这件事已在别处处理（或已经关了），不用再定：重新 list 看现在的样子") };
  if (item.gen !== input.gen) return { ok: false, result: fail("stale", "这件事刚变过（比如来了新的一组），先把新的样子给创始人看一遍再定", { item: await shownNow(item, input, dataDir) }) };
  if (!item.content_id || !chatActionsOf(item).includes(input.decision)) {
    const why = CHAT_ACTIONS[item.type] ? `这件事在这里不能做「${input.decision}」` : "这类事只能在看板上定";
    return { ok: false, result: fail("not_chat_decidable", why, { board_link: boardLink(item) }) };
  }
  const badUrl = input.decision === "i_published" && str(input.url) ? urlMismatch(String(item.detail.platform ?? ""), str(input.url)) : null;
  if (badUrl) return { ok: false, result: fail("url_platform_mismatch", badUrl, { item: await shownNow(item, input, dataDir) }) };
  const selection = selectionOf(item, input.decision, { group_id: str(input.group_id) || undefined, fact_id: str(input.fact_id) || undefined, option_id: str(input.option_id) || undefined });
  if (!selection.ok) return { ok: false, result: fail(selection.code, selection.error, { item: await shownNow(item, input, dataDir) }) };
  return { ok: true, item, selection };
}

/** 封面字：创始人在对话里说的（显式参数）> 这组自己的字 / 交接时定的字。服务端算一次，原样提交 */
function coverTextOf(item: InboxItem, input: ChatDecideInput, selection: Picked): Result {
  if (input.decision !== "pick_cover") return {};
  if (typeof input.cover_text === "string") return { cover_text: input.cover_text.trim() };
  const g = (item.detail.groups as Array<{ group_id: string; text: string }>).find((x) => x.group_id === selection.params.group_id);
  return { cover_text: (g?.text ?? "").trim() };
}

function validInput(input: ChatDecideInput): Result | null {
  if (!isRequestId(str(input.request_id))) return fail("invalid_params", "要带 request_id（1–100 位字母、数字、-、_），重试用同一个");
  if (!str(input.founder_words)) return fail("founder_words_required", "带上创始人在对话里的原话（founder_words），一字不改照抄");
  if (!str(input.item_id) || !str(input.gen) || !str(input.decision)) return fail("invalid_params", "要带 item_id、gen 和 decision（list 里给的）");
  if (NOTE_ACTIONS.has(str(input.decision)) && !str(input.note)) return fail("note_required", "写一句要改哪里（note），给做的人看");
  return null;
}

const hashOf = (input: ChatDecideInput, requester: string) => payloadHash({ item_id: input.item_id, gen: input.gen, decision: input.decision,
  group_id: str(input.group_id), fact_id: str(input.fact_id), ...(str(input.option_id) ? { option_id: str(input.option_id) } : {}), ...(str(input.url) ? { url: str(input.url) } : {}), cover_text: typeof input.cover_text === "string" ? input.cover_text.trim() : null,
  note: str(input.note), founder_words: str(input.founder_words), requester });

type Bind = (b: Binding) => Promise<void>;

/**
 * 同一个请求号只走一个调用；同号换内容拒；有结果的回放；落了账没结果的按绑定找回，找不到再跑。
 * 一进来先落账（pending + 内容哈希），失败的也留着这份绑定。
 */
export async function once(requestId: string, hash: string, dataDir: string, run: (bind: Bind) => Promise<Result>): Promise<Result> {
  if (!claimRequest(requestId)) return fail("in_progress", "同一个 request_id 正在处理，等它出结果");
  try {
    const prior = await readRequest(dataDir, requestId);
    if (prior && prior.payload_hash !== hash) return fail("request_conflict", "这个 request_id 已经用在另一件事 / 另一个决定上了：换一个新的");
    if (prior?.state === "committed") return { ...prior.result, replayed: true };
    const recovered = prior ? await recoverRequest(dataDir, prior) : null;
    if (recovered) return recovered;
    let rec: RequestRecord = { request_id: requestId, payload_hash: hash, state: "pending", at: new Date().toISOString() };
    await writeRequest(dataDir, rec);
    // 跑的途中抛了也要落到终态（failed + 看得见的原因），不留 pending
    const r = await run(async (binding) => { rec = { ...rec, binding }; await writeRequest(dataDir, rec); })
      .catch((e: unknown) => fail("failed", `没做成：${e instanceof Error ? e.message : String(e)}`));
    await writeRequest(dataDir, { ...rec, state: r.ok === true ? "committed" : "failed", result: r });
    return r;
  } finally {
    releaseRequest(requestId);
  }
}

/** decide：按创始人原话记一个决定（E5–E8、E13、E15） */
export async function chatDecide(input: ChatDecideInput, dataDir = getDataDir()): Promise<Result> {
  const bad = validInput(input);
  if (bad) return bad;
  const requester = requesterOf(input.host, input.session);
  return once(str(input.request_id), hashOf(input, requester), dataDir, (bind) => commit(input, requester, dataDir, bind));
}

/** 锁后 decideItem 的失败换成对话的口径：代次变了 → stale + 新样子；没了 / 定过别的 → already_handled */
async function normalize(r: Result, itemId: string, input: ChatDecideInput, dataDir: string): Promise<Result> {
  if (r.code === "gone" || r.code === "already_decided") return fail("already_handled", "这件事已在别处处理（或已经关了），不用再定：重新 list 看现在的样子");
  if (r.code !== "stale") return r;
  const fresh = (await readInbox(dataDir)).items.find((x) => x.item_id === itemId);
  if (!fresh) return fail("already_handled", "这件事已在别处处理（或已经关了），不用再定：重新 list 看现在的样子");
  return fail("stale", "这件事刚变过，先把新的样子给创始人看一遍再定", { item: await shownNow(fresh, input, dataDir) });
}

/** 测试注入（破例要重跑检查，会问 Jev）；生产走默认 */
let decideDeps: DecideDeps = {};
export function setChatDecideDeps(d: DecideDeps | null): void { decideDeps = d ?? {}; }

/** note：要改哪里的；请示多说的话；破例 = 创始人原话原样（Addendum 2） */
function noteOf(input: ChatDecideInput): Result {
  if (input.decision === "publish_check_override") return { note: str(input.founder_words) };
  if (NOTE_ACTIONS.has(input.decision) || (input.decision === "answer_ask" && str(input.note))) return { note: str(input.note) };
  return {};
}

/** 「没问题」= 照这份发：现算发布包里每个文件（换了字节、还在写的都拒），计划变了也拒，拒了给现在的样子 */
async function publishFresh(item: InboxItem, input: ChatDecideInput, dataDir: string): Promise<Result | null> {
  if (input.decision !== "publish_check_confirm") return null;
  const v = await verifyCheck(item.content_id!, String(item.detail.check_id), dataDir);
  if (v.ok) return null;
  const extra = async () => ({ board_link: boardLink(item), item: await shownNow(item, input, dataDir) });
  if (await checkFilesUnsettled(item.content_id!, String(item.detail.check_id), dataDir)) return fail("file_unsettled", "文件还在写，等一分钟再定：这次什么都没记", await extra());
  return fail(v.code, `${v.error}：这次什么都没记`, await extra());
}

async function commit(input: ChatDecideInput, requester: string, dataDir: string, bind: Bind): Promise<Result> {
  const found = await locate(input, dataDir);
  if (!found.ok) return found.result;
  const { item, selection } = found;
  const req = { item_id: item.item_id, gen: item.gen, action: input.decision, content_id: item.content_id, ...selection.params,
    ...coverTextOf(item, input, selection), ...noteOf(input), ...(input.decision === "i_published" && str(input.url) ? { url: str(input.url) } : {}) };
  await bind({ content_id: item.content_id!, item_id: item.item_id, gen: item.gen, decision: input.decision, fp: fingerprint(input.decision, req) });
  // 全新的请求对象：不带 _host / _session（模型调用标记），来源经调用链挂上
  const run = () => withProvenance({ source: "chat", founder_words: str(input.founder_words), requested_by: requester, request_id: str(input.request_id) }, () => decideItem(req, dataDir, decideDeps));
  // 破例要等 Jev 重跑：和网页一样由 decideItem 自己管锁的边界，不在外面握着所有权锁等模型
  const r = input.decision === "publish_check_override" ? await run() : await withFileOwnership(async () => {
    const bytes = await verifyFacts(item.content_id!, selection.factIds, dataDir);
    if (!bytes.ok) return fail(bytes.code, bytes.error, { board_link: boardLink(item), item: await shownNow(item, input, dataDir) });
    return (await publishFresh(item, input, dataDir)) ?? run();
  });
  if (r.ok !== true) return normalize(r, item.item_id, input, dataDir);
  const id = (r.decision as { id?: string } | undefined)?.id;
  return { ...r, recorded_as: "chat", next_action: `告诉创始人已经按他的原话记下了${id ? `；他要撤回就 revoke{content_id:"${item.content_id}", decision_id:"${id}"}（只有批准能撤）` : ""}。` };
}

/** revoke：「撤回刚才那个」——走现有的撤回批准（只撤本轮的成片 / 封面批准） */
export async function chatRevoke(input: ChatDecideInput, dataDir = getDataDir()): Promise<Result> {
  if (!isRequestId(str(input.request_id))) return fail("invalid_params", "要带 request_id，重试用同一个");
  if (!str(input.founder_words)) return fail("founder_words_required", "带上创始人要撤回时的原话（founder_words），一字不改照抄");
  const contentId = str(input.content_id), decisionId = str(input.decision_id);
  if (!contentId || !decisionId) return fail("invalid_params", "要带 content_id 和 decision_id（decide 回执里给的）");
  const requester = requesterOf(input.host, input.session);
  const hash = payloadHash({ revoke: decisionId, content_id: contentId, founder_words: str(input.founder_words), requester });
  const run = () => withProvenance({ source: "chat", founder_words: str(input.founder_words), requested_by: requester, request_id: str(input.request_id) },
    () => founderDecision(contentId, "revoke_approval", { decision_id: decisionId }, dataDir));
  return once(str(input.request_id), hash, dataDir, run);
}
