/**
 * 剪辑途中的请示（spec 2026-09-30-review-inbox §5）。
 *
 * - agent：`ask` 发起（2–4 个带 id 的选项、附件必须在本条项目内并记下 sha；分镜请示绑分镜快照）、
 *   `withdraw_ask` 撤回、`answer_ask` 转述创始人在聊天里的原话（花费 / 分镜不收转述）。
 * - 创始人：在「等你拍板」里答（决定 ask_answer，via=founder）、撤回 agent 的转述（24 小时内）。
 * - 同条同 kind 的未答旧请示被新请示取代；取代 / 撤回 / 关闭（稿重开、归档、删除）之后的回答一律拒。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, getDataDir, type Content } from "../../storage/local-store.js";
import { contentRoot } from "../../storage/content-project.js";
import { isOntologyActive, newId, readProductionDocOrEmpty } from "../../storage/production-store.js";
import { ASK_KINDS, type Ask, type AskAnswer, type AskKind, type AskOption, type Decision, type ProductionDoc } from "../../storage/production-types.js";
import { isWithin } from "../../storage/storage-roots.js";
import { sha256File } from "../video/handoff/manifest.js";
import { resolveLocalFile } from "./files.js";
import { repairQuotes } from "../publish/review-gate/plan.js";
import { withFileOwnership } from "./mutex.js";
import { ensureProductionReady, mutateProduction } from "./service.js";
import { validateStoryboard } from "./storyboard.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : "");

/** 转述的回答可撤回的时长 */
export const REPORTED_UNDO_MS = 24 * 3600_000;
/** 分镜请示里表示「通过」的选项 id：答它 = 同时写分镜决定 */
export const STORYBOARD_APPROVE = "approve";
/** 转述不收的请示：花费一旦发生撤不回；分镜通过会写分镜决定（§5.3） */
const NO_REPORTED: ReadonlySet<AskKind> = new Set(["花费", "分镜"]);

// ---- 参数正规化（中转端点会把数组 / 对象序列化成字符串） ----

/** 字符串里的 JSON：先原样解析，再修中转端点留下的没转义内层引号（与发布检查同一个 repairQuotes） */
function maybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  for (const attempt of [t, repairQuotes(t), t.replace(/'/g, '"')]) {
    try { return JSON.parse(attempt) as unknown; } catch { /* 换下一种修法 */ }
  }
  return v;
}

export function parseOptions(raw: unknown): { ok: true; value: AskOption[] } | { ok: false; error: string } {
  const v = maybeJson(raw);
  if (!Array.isArray(v)) return { ok: false, error: "options 要是 2–4 个 {id, label} 的数组" };
  const out: AskOption[] = [];
  for (const [i, o] of v.entries()) {
    const x = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    const id = str(x.id), label = str(x.label);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return { ok: false, error: `options[${i}].id 要是 1–32 位字母数字 _ -` };
    if (!label || Array.from(label).length > 40) return { ok: false, error: `options[${i}].label 要有字、不超过 40 字` };
    if (out.some((y) => y.id === id)) return { ok: false, error: `options 里 id「${id}」重复了` };
    out.push({ id, label });
  }
  if (out.length < 2 || out.length > 4) return { ok: false, error: `options 要 2–4 个，收到 ${out.length} 个` };
  return { ok: true, value: out };
}

function parseAttachments(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: [] };
  const v = maybeJson(raw);
  const list = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const [i, a] of list.entries()) {
    const p = typeof a === "string" ? a.trim() : str((a as Record<string, unknown> | null)?.path);
    if (!p) return { ok: false, error: `attachments[${i}] 要是 {path}` };
    out.push(p);
  }
  return out.length > 8 ? { ok: false, error: "附件最多 8 个" } : { ok: true, value: out };
}

// ---- 状态 ----

export type AskStatus = Ask["state"] | "closed";

/** 请示现在的状态：稿重开 / 归档 / 删除之后未答的一律「关了」（由读方推出，不靠谁记得去改） */
export function askStatus(ask: Ask, doc: ProductionDoc, content: Pick<Content, "status" | "deletedAt"> | null): { status: AskStatus; reason?: string } {
  if (ask.state !== "open") return { status: ask.state };
  if (!content || content.deletedAt) return { status: "closed", reason: "稿子删了" };
  if (content.status === "archived") return { status: "closed", reason: "稿子归档了" };
  if (ask.round !== doc.round) return { status: "closed", reason: "稿子重开了" };
  return { status: "open" };
}

const ENDED: Record<Exclude<AskStatus, "open">, string> = { answered: "这件事已经答过了", superseded: "这件事已被新请示取代", withdrawn: "agent 已经撤回了这件事", closed: "这件事已经关了" };

/** 能不能答：不能就回原因 */
function answerable(ask: Ask | undefined, doc: ProductionDoc, content: Content | null): string | null {
  if (!ask) return "没有这件请示";
  const s = askStatus(ask, doc, content);
  return s.status === "open" ? null : `${ENDED[s.status]}${s.reason ? `（${s.reason}）` : ""}`;
}

async function attachmentShas(root: string, ask: Ask): Promise<Array<string | null>> {
  return Promise.all(ask.attachments.map((a) => sha256File(path.join(root, a.path)).catch(() => null)));
}

/** 附件在答之前变了（sha 不符 / 不见了）：条目提示「附件刚变过」 */
export async function attachmentsChanged(contentId: string, ask: Ask, dataDir: string): Promise<boolean> {
  const now = await attachmentShas(contentRoot(contentId, dataDir), ask);
  return now.some((s, i) => s !== ask.attachments[i].sha256);
}

// ---- agent：发起 / 撤回 / 转述 ----

interface AgentCtx { content: Content; dataDir: string; host: string; session?: string }

async function agentCtx(params: Record<string, unknown>): Promise<AgentCtx | { err: Result }> {
  const contentId = str(params.content_id) || str(params.id);
  if (!contentId) return { err: fail("bad_param", "要带 content_id") };
  const dataDir = getDataDir(params._dataDir as string | undefined);
  const content = await getContent(contentId, dataDir);
  if (!content || content.deletedAt) return { err: fail("not_found", `找不到这篇稿（${contentId}）`) };
  if (!(await isOntologyActive(dataDir, contentId))) return { err: fail("ontology_not_enabled", "本体还没启用（或这条被排除），请示还不能记：先在聊天里问创始人") };
  await ensureProductionReady(dataDir);
  return { content, dataDir, host: str(params._host) || "local-user", ...(str(params._session) ? { session: str(params._session) } : {}) };
}

async function projectAttachment(root: string, input: string): Promise<{ ok: true; rel: string; sha256: string } | { ok: false; error: string }> {
  const at = await resolveLocalFile(input, "附件", [root]);
  if (!at.ok) return { ok: false, error: at.error };
  const realRoot = await fs.realpath(root);
  if (!isWithin(realRoot, at.value)) return { ok: false, error: `附件要在本条项目里（${input} 不在）：先放进项目再问` };
  return { ok: true, rel: path.relative(realRoot, at.value), sha256: await sha256File(at.value) };
}

async function storyboardSnapshot(root: string, doc: ProductionDoc, factId: string): Promise<{ ok: true; value: NonNullable<Ask["storyboard"]> } | { ok: false; error: string }> {
  const f = doc.facts.find((x) => x.id === factId && x.kind === "storyboard" && x.state === "accepted");
  if (!f?.path) return { ok: false, error: `分镜请示要指定本条的分镜事实（storyboard_fact_id）：${factId || "没带"}` };
  const v = await validateStoryboard(root, f.path);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.value.sha256 !== f.sha256) return { ok: false, error: "审阅页在报上之后被改过：重新生成并 record kind=storyboard 再问" };
  const receipt = await fs.readFile(path.join(await fs.realpath(root), f.path.replace(/\.html$/i, ".receipt.json")), "utf8");
  const media = (JSON.parse(receipt) as { media?: unknown }).media ?? [];
  return { ok: true, value: { fact_id: f.id, sha256: v.value.sha256, receipt_sha256: v.value.receipt_sha256, assets_fp: crypto.createHash("sha256").update(JSON.stringify(media)).digest("hex"), round: doc.round } };
}

const askArgs = (kind: string, question: string, options: AskOption[], sb: string) => JSON.stringify([kind, question, options, sb]);

export async function executeAsk(params: Record<string, unknown>): Promise<Result> {
  const ctx = await agentCtx(params);
  if ("err" in ctx) return ctx.err;
  const request_id = str(params.request_id);
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(request_id)) return fail("bad_param", "ask 要带 request_id（重试用同一个）");
  const kind = str(params.kind) as AskKind;
  if (!ASK_KINDS.includes(kind)) return fail("bad_param", `kind 只能是 ${ASK_KINDS.join(" / ")}`);
  const question = str(params.question);
  if (!question || Array.from(question).length > 300) return fail("bad_param", "question 要有字、不超过 300 字");
  const options = parseOptions(params.options);
  if (!options.ok) return fail("bad_param", options.error);
  const atts = parseAttachments(params.attachments);
  if (!atts.ok) return fail("bad_param", atts.error);
  const sbId = str(params.storyboard_fact_id) || (kind === "分镜" ? str(params.fact_id) : "");
  if (kind === "分镜" && !options.value.some((o) => o.id === STORYBOARD_APPROVE)) return fail("bad_param", `分镜请示要有一个 id="${STORYBOARD_APPROVE}" 的选项（答它 = 分镜通过）`);
  const { content, dataDir } = ctx;
  const root = contentRoot(content.id, dataDir);
  return withFileOwnership(async () => {
    const doc = await readProductionDocOrEmpty(content.id, dataDir);
    const prior = (doc.asks ?? []).find((x) => x.request_id === request_id);
    if (prior) {
      const same = askArgs(prior.kind, prior.question, prior.options, prior.storyboard?.fact_id ?? "") === askArgs(kind, question, options.value, sbId);
      return same ? { ok: true, ask_id: prior.id, state: prior.state, replayed: true } : fail("request_conflict", `request_id「${request_id}」已经用来问过另一件事：换一个新的 request_id`);
    }
    const attachments: Ask["attachments"] = [];
    for (const input of atts.value) {
      const a = await projectAttachment(root, input);
      if (!a.ok) return fail("attachment_outside", a.error);
      attachments.push({ path: a.rel, sha256: a.sha256 });
    }
    let storyboard: Ask["storyboard"];
    if (kind === "分镜") {
      const s = await storyboardSnapshot(root, doc, sbId);
      if (!s.ok) return fail("storyboard_required", s.error);
      storyboard = s.value;
    }
    const r = await mutateProduction(content.id, dataDir, (d) => {
      const at = new Date().toISOString();
      const ask: Ask = { id: newId("ask"), request_id, round: d.round, kind, question, options: options.value, attachments, ...(storyboard ? { storyboard } : {}), at,
        by: { host: ctx.host, ...(ctx.session ? { session: ctx.session } : {}) }, state: "open" };
      // 同条同 kind 的未答旧请示被新请示取代（R6）
      const replaced = (d.asks ?? []).filter((x) => x.state === "open" && x.kind === kind && x.round === d.round);
      for (const x of replaced) Object.assign(x, { state: "superseded", superseded_by: ask.id, ended_at: at });
      d.asks = [...(d.asks ?? []), ask];
      return { value: { ask, replaced: replaced.map((x) => x.id) }, events: [{ type: "ask_opened", detail: { ask_id: ask.id, kind, by: ctx.host, superseded: replaced.map((x) => x.id) } }] };
    });
    return { ok: true, ask_id: r.value.ask.id, state: "open", ...(r.value.replaced.length ? { superseded: r.value.replaced } : {}),
      next_action: "已放进创始人的「等你拍板」。不要在聊天里再问一遍；用 autocrew_content summary 看 asks[] 里的答复（带 asks_offset 翻页）。创始人在聊天里答了，用 answer_ask 逐字转述（花费、分镜不收转述）。" };
  });
}

export async function executeWithdrawAsk(params: Record<string, unknown>): Promise<Result> {
  const ctx = await agentCtx(params);
  if ("err" in ctx) return ctx.err;
  const askId = str(params.ask_id);
  return withFileOwnership(async () => {
    const doc = await readProductionDocOrEmpty(ctx.content.id, ctx.dataDir);
    const ask = (doc.asks ?? []).find((x) => x.id === askId);
    if (!ask) return fail("not_found", `没有这件请示：${askId}`);
    if (ask.state === "withdrawn") return { ok: true, ask_id: askId, state: "withdrawn", note: "之前已经撤回了" };
    const why = answerable(ask, doc, ctx.content);
    if (why) return fail("ask_closed", why);
    await mutateProduction(ctx.content.id, ctx.dataDir, (d) => {
      Object.assign(d.asks!.find((x) => x.id === askId)!, { state: "withdrawn", ended_at: new Date().toISOString() });
      return { value: null, events: [{ type: "ask_withdrawn", detail: { ask_id: askId, by: ctx.host } }] };
    });
    return { ok: true, ask_id: askId, state: "withdrawn" };
  });
}

/** agent 转述创始人在聊天里的回答（§5.3）：原话逐字；花费、分镜不收；24 小时内创始人可撤回 */
export async function executeAnswerAsk(params: Record<string, unknown>): Promise<Result> {
  const ctx = await agentCtx(params);
  if ("err" in ctx) return ctx.err;
  const askId = str(params.ask_id), optionId = str(params.option_id), quote = str(params.founder_quote);
  if (!quote) return fail("bad_param", "answer_ask 要带 founder_quote：创始人在聊天里的原话，逐字");
  return withFileOwnership(async () => {
    const doc = await readProductionDocOrEmpty(ctx.content.id, ctx.dataDir);
    const ask = (doc.asks ?? []).find((x) => x.id === askId);
    if (ask?.state === "answered" && ask.answer?.via === "agent_reported" && ask.answer.option_id === optionId && ask.answer.quote === quote) return { ok: true, ask_id: askId, state: "answered", replayed: true };
    const why = answerable(ask, doc, ctx.content);
    if (why) return fail("ask_closed", why);
    if (NO_REPORTED.has(ask!.kind)) return fail("founder_only", `「${ask!.kind}」请示只认创始人在「等你拍板」里点（或会话窗口的确认框），不收转述`);
    if (!ask!.options.some((o) => o.id === optionId)) return fail("bad_param", `option_id 要是这件请示的选项之一：${ask!.options.map((o) => o.id).join(" / ")}`);
    await mutateProduction(ctx.content.id, ctx.dataDir, (d) => {
      const answer: AskAnswer = { option_id: optionId, via: "agent_reported", quote, host: ctx.host, at: new Date().toISOString() };
      Object.assign(d.asks!.find((x) => x.id === askId)!, { state: "answered", answer, ended_at: answer.at });
      return { value: null, events: [{ type: "ask_answered", detail: { ask_id: askId, option_id: optionId, via: "agent_reported", by: ctx.host } }] };
    });
    return { ok: true, ask_id: askId, state: "answered", via: "agent_reported", next_action: "已记成你转述的回答；创始人 24 小时内可以在「等你拍板」里撤回，summary 的 asks[] 会显示。" };
  });
}

// ---- 创始人：答 / 撤回转述（调用方持有文件归属锁，经「等你拍板」单一入口） ----

export async function founderAnswer(content: Content, dataDir: string, askId: string, optionId: string, note: string): Promise<Result> {
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  const ask = (doc.asks ?? []).find((x) => x.id === askId);
  const why = answerable(ask, doc, content);
  if (why) return fail("ask_closed", why);
  if (!ask!.options.some((o) => o.id === optionId)) return fail("bad_request", "这个选项不在这件请示里，刷新再看");
  const root = contentRoot(content.id, dataDir);
  // 每个显式附件都核 sha（任何 kind，分镜也一样；Codex 审 2a-1 r2 P2），分镜快照再另核
  if (await attachmentsChanged(content.id, ask!, dataDir)) return fail("attachments_changed", "附件刚变过：重新看一下再答");
  let storyboardApproval: Omit<Decision, "id" | "round" | "at" | "source"> | null = null;
  if (ask!.storyboard) {
    const now = await storyboardSnapshot(root, doc, ask!.storyboard.fact_id);
    const same = now.ok && now.value.sha256 === ask!.storyboard.sha256 && now.value.receipt_sha256 === ask!.storyboard.receipt_sha256 && now.value.assets_fp === ask!.storyboard.assets_fp && ask!.storyboard.round === doc.round;
    if (!same) return fail("storyboard_changed", "分镜在请示之后变过（页面、回执或素材）：请 agent 重新生成分镜再问");
    if (optionId === STORYBOARD_APPROVE) storyboardApproval = { type: "storyboard_approval", fact_id: ask!.storyboard.fact_id, sha256: ask!.storyboard.sha256, receipt_sha256: ask!.storyboard.receipt_sha256, ask_id: askId };
  }
  const r = await mutateProduction(content.id, dataDir, (d) => {
    const at = new Date().toISOString();
    const dec: Decision = { id: newId("dec"), type: "ask_answer", round: d.round, at, source: "founder", ask_id: askId, option_id: optionId, ...(note ? { note } : {}) };
    d.decisions.push(dec);
    if (storyboardApproval) d.decisions.push({ id: newId("dec"), round: d.round, at, source: "founder", ...storyboardApproval });
    const answer: AskAnswer = { option_id: optionId, ...(note ? { note } : {}), via: "founder", at, decision_id: dec.id };
    Object.assign(d.asks!.find((x) => x.id === askId)!, { state: "answered", answer, ended_at: at });
    return { value: dec, events: [{ type: "ask_answered", detail: { ask_id: askId, option_id: optionId, via: "founder", decision_id: dec.id, ...(storyboardApproval ? { storyboard_approved: storyboardApproval.fact_id } : {}) } }] };
  });
  return { ok: true, decision: r.value, ...(storyboardApproval ? { storyboard_approved: true } : {}) };
}

export async function undoReportedAnswer(content: Content, dataDir: string, askId: string, now = Date.now()): Promise<Result> {
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  const ask = (doc.asks ?? []).find((x) => x.id === askId);
  if (!ask || ask.state !== "answered" || ask.answer?.via !== "agent_reported") return fail("stale", "这件请示没有 agent 转述的回答可撤，刷新再看");
  if (now - Date.parse(ask.answer.at) > REPORTED_UNDO_MS) return fail("too_late", "转述的回答超过 24 小时了，不能再撤回");
  if (ask.round !== doc.round || content.status === "archived") return fail("ask_closed", "这件事已经关了");
  const r = await mutateProduction(content.id, dataDir, (d) => {
    const dec: Decision = { id: newId("dec"), type: "ask_answer_undo", round: d.round, at: new Date().toISOString(), source: "founder", ask_id: askId, option_id: ask.answer!.option_id };
    d.decisions.push(dec);
    const x = d.asks!.find((y) => y.id === askId)!;
    x.history = [...(x.history ?? []), x.answer!];
    delete x.answer;
    delete x.ended_at;
    x.state = "open";
    return { value: dec, events: [{ type: "ask_answer_undone", detail: { ask_id: askId, decision_id: dec.id } }] };
  });
  return { ok: true, decision: r.value };
}

// ---- summary 的 asks[]（独立游标 asks_offset，不与 since_seq 混用） ----

/** reported = agent 转述的回答（24 小时内创始人可撤回） */
export interface AskRow { ask_id: string; kind: AskKind; state: AskStatus | "reported"; option_id?: string; note?: string; via?: AskAnswer["via"]; reason?: string }

export function askRows(doc: ProductionDoc, content: Content): AskRow[] {
  return [...(doc.asks ?? [])].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).map((a) => {
    const s = askStatus(a, doc, content);
    return { ask_id: a.id, kind: a.kind, state: s.status === "answered" && a.answer?.via === "agent_reported" ? "reported" : s.status, ...(a.answer ? { option_id: a.answer.option_id, via: a.answer.via, ...(a.answer.note ? { note: a.answer.note } : {}) } : {}), ...(s.reason ? { reason: s.reason } : {}) };
  });
}
