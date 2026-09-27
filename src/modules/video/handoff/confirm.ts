/**
 * `autocrew_video confirm{receipt_id, content_id?, cover_text, target_seconds, request_id}`（P6 §12.4-C）。
 *
 * 服务端核回执与原片（有音轨、不超 30 分钟）→ 按回执前三名逐条实时核材料（审稿或导入稿条件、出处覆盖），
 * 只把材料齐的交弹窗、一条都不齐就直接拒不弹窗 → 在创始人的 Mac 上弹系统窗让他选稿（选后再核一遍材料）
 * → 再弹一个确认窗列出文件名、稿件、平台、封面字、目标时长（导入稿多一行说明；工作台已有不同的决定就并列两套值，
 * 由创始人选，不静默覆盖）。点了「确认」才由服务端写确认记录和 decisions.json（source:"native-dialog"）。
 *
 * 最多阻塞 5 分钟：没人点 → confirm_timeout，什么都不记；取消 → confirm_declined；
 * 非 macOS / 没有图形会话 → confirm_unavailable。同一 request_id 重试返回同一条记录，不重复弹窗。
 */
import path from "node:path";
import { writeJsonAtomic } from "../../../storage/json-atomic.js";
import { contentFile } from "../../../storage/content-project.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import { readArollInput } from "./aroll-input.js";
import type { DialogOutcome } from "./dialog.js";
import { DIALOG_TOP_N, eligibility, readReceipt, receiptProblem, type MatchReceipt, type ReceiptCandidate } from "./match.js";
import { readProjectJson, validateCoverage, type CitationCoverage, type ProjectDecisions } from "./project-evidence.js";
import { pullDeps } from "./pull-deps.js";
import { newId, pullDir, readRecord, requestFile, REQUEST_ID_RE, writeRecord } from "./pull-store.js";
import { handoffFail, type HandoffResult } from "./types.js";

export const CONFIRM_TIMEOUT_MS = 5 * 60_000;
export const CONFIRMATION_TTL_MS = 30 * 60_000;
export const IMPORT_LINE = "这篇是导入稿，没过文字审稿，按录音为准交接";
const TITLE = "AutoCrew 交接确认";
const MAX_EDIT_ROUNDS = 3;

export interface ConfirmationRecord {
  confirmation_id: string;
  source: "native-dialog";
  content_id: string;
  draft_hash: string;
  aroll_sha256: string;
  aroll_path: string;
  receipt_id: string;
  request_id: string;
  cover_text: string;
  target_seconds: number;
  clicked_at: string;
  expires_at: string;
  dialog_text: string;
  recorded_as_is?: true;
  used_at?: string;
  used_by_request?: string;
}

export function confirmationFile(dataDir: string, id: string): string {
  if (!/^cfm-[a-z0-9-]+$/.test(id)) throw new Error("confirmation_id 不合法");
  return pullDir(dataDir, "confirmations", `${id}.json`);
}

export async function readConfirmation(dataDir: string, id: string): Promise<ConfirmationRecord | null> {
  return readRecord<ConfirmationRecord>(confirmationFile(dataDir, id));
}

export interface ConfirmInput {
  receiptId: string;
  contentId?: string;
  coverText: string;
  targetSeconds: number;
  requestId: string;
}

type Values = { cover: string; seconds: number };

function secondsLeft(deadline: number): number {
  return Math.floor((deadline - pullDeps().now()) / 1000);
}

function dialogFailure(outcome: DialogOutcome<unknown>): HandoffResult | null {
  if (outcome.kind === "ok") return null;
  if (outcome.kind === "timeout") return { ok: false, code: "confirm_timeout", error: "5 分钟内没人点弹窗，这次什么都没记。创始人在 Mac 前时再调一次 confirm。" };
  if (outcome.kind === "cancel") return { ok: false, code: "confirm_declined", error: "创始人在弹窗里点了取消，这次不交接。" };
  return { ok: false, code: "confirm_unavailable", error: `这台机器弹不出确认窗（${outcome.reason}）：请创始人在 AutoCrew 工作台确认交接信息。`,
    next_action: "停下，告诉创始人去工作台确认标题、封面字、目标时长；不要把对话里的原话当确认。" };
}

function label(c: ReceiptCandidate, i: number): string {
  return `${i + 1}. ${c.title}（${c.platform}）${c.unreviewed_import ? "［导入稿］" : ""}`;
}

/** 弹窗能列的候选：回执前三名（外加点名的那条）里材料齐的；一条都不齐就不弹窗，直接回拒绝 */
async function offerable(receipt: MatchReceipt, input: ConfirmInput, dataDir: string): Promise<{ ok: true; value: ReceiptCandidate[] } | { ok: false; result: HandoffResult }> {
  const top = receipt.candidates.slice(0, DIALOG_TOP_N);
  const named = input.contentId ? receipt.candidates.find((c) => c.content_id === input.contentId) : undefined;
  if (input.contentId && !named) return { ok: false, result: handoffFail("invalid_params", "content_id 不在这张回执的候选里：候选只能取自回执") };
  const pool = named && !top.includes(named) ? [...top, named] : top;
  const refused: Array<{ candidate: ReceiptCandidate; result: HandoffResult }> = [];
  const ready: ReceiptCandidate[] = [];
  for (const cand of pool) {
    const content = await getContent(cand.content_id, dataDir);
    const result = content ? await materialsProblem(content, dataDir) : handoffFail("not_accepted", `候选稿不存在了：${cand.content_id}`);
    if (result) refused.push({ candidate: cand, result });
    else ready.push(cand);
  }
  if (ready.length) return { ok: true, value: ready };
  if (refused.length === 1) return { ok: false, result: refused[0].result };
  const details = refused.map(({ candidate, result }) => ({ content_id: candidate.content_id, title: candidate.title, code: result.code, error: result.error }));
  return { ok: false, result: { ...refused[0].result, error: `候选稿都还交不了：${details.map((d) => `「${d.title}」${String(d.error)}`).join("；")}`, candidates: details } };
}

async function pickCandidate(receipt: MatchReceipt, shown: ReceiptCandidate[], input: ConfirmInput, deadline: number): Promise<{ ok: true; value: ReceiptCandidate } | { ok: false; result: HandoffResult }> {
  const named = input.contentId ? shown.find((c) => c.content_id === input.contentId) : undefined;
  const items = shown.map(label);
  const picked = await pullDeps().dialog.choose({
    title: TITLE, prompt: `原片「${path.basename(receipt.aroll_path)}」录的是哪一条稿？`, items,
    ...(named ? { defaultItem: items[shown.indexOf(named)] } : {}), timeoutSec: secondsLeft(deadline),
  });
  const failed = dialogFailure(picked);
  if (failed) return { ok: false, result: failed };
  const index = items.indexOf((picked as { value: string }).value);
  if (index < 0) return { ok: false, result: { ok: false, code: "confirm_declined", error: "弹窗没有选中任何候选" } };
  return { ok: true, value: shown[index] };
}

/** 材料实时核（§12.4-A）：审稿 accepted 或导入稿条件；出处覆盖当前定稿 */
async function materialsProblem(content: Content, dataDir: string): Promise<HandoffResult | null> {
  const e = eligibility(content, dataDir);
  if (!e.ok) return handoffFail("not_accepted", `「${content.title}」现在交不了：${e.reason}`);
  const coverage = await readProjectJson<CitationCoverage>(content.id, "citations.json", dataDir);
  const problems = coverage ? validateCoverage(content, coverage) : ["还没有提交出处映射"];
  if (!problems.length) return null;
  return handoffFail("missing_citations", `出处映射缺失或不覆盖当前定稿：${problems.join("；")}`, {
    problems, next_action: "停下：回 Claude 写稿会话，用 autocrew_video citations 补齐当前定稿的出处，再重新 match。",
  });
}

function summary(file: string, content: Content, v: Values, unreviewed: boolean): string {
  return [`原片：${file}`, `稿件：${content.title}`, `平台：${content.platform}`, `封面字：${v.cover}`, `目标时长：${v.seconds} 秒`,
    ...(unreviewed ? [IMPORT_LINE] : [])].join("\n");
}

async function editValues(v: Values, deadline: number): Promise<{ ok: true; value: Values } | { ok: false; result: HandoffResult }> {
  const dialog = pullDeps().dialog;
  const cover = await dialog.input({ title: TITLE, prompt: "封面字改成：", defaultAnswer: v.cover, timeoutSec: secondsLeft(deadline) });
  const coverFail = dialogFailure(cover);
  if (coverFail) return { ok: false, result: coverFail };
  const secs = await dialog.input({ title: TITLE, prompt: "目标时长（秒）：", defaultAnswer: String(v.seconds), timeoutSec: secondsLeft(deadline) });
  const secsFail = dialogFailure(secs);
  if (secsFail) return { ok: false, result: secsFail };
  const nextCover = (cover as { value: string }).value.trim() || v.cover;
  const n = Number((secs as { value: string }).value.trim());
  return { ok: true, value: { cover: nextCover, seconds: Number.isFinite(n) && n > 0 ? Math.round(n) : v.seconds } };
}

type Confirmed = { ok: true; values: Values; text: string } | { ok: false; result: HandoffResult };

/** 工作台已有不同的决定：并列两套值，让创始人选，不静默覆盖 */
async function resolveConflict(base: string, mine: Values, bench: Values, deadline: number): Promise<Confirmed> {
  const text = `${base}\n\n工作台已确认：封面字「${bench.cover}」，${bench.seconds} 秒\n本次：封面字「${mine.cover}」，${mine.seconds} 秒`;
  const answer = await pullDeps().dialog.ask({ title: TITLE, prompt: text, buttons: ["取消", "用工作台的", "用本次的"],
    defaultButton: "用本次的", cancelButton: "取消", timeoutSec: secondsLeft(deadline) });
  const failed = dialogFailure(answer);
  if (failed) return { ok: false, result: failed };
  return { ok: true, values: (answer as { value: string }).value === "用工作台的" ? bench : mine, text };
}

async function confirmValues(file: string, content: Content, start: Values, unreviewed: boolean, bench: Values | null, deadline: number): Promise<Confirmed> {
  let v = start;
  if (bench && (bench.cover !== v.cover || bench.seconds !== v.seconds)) return resolveConflict(summary(file, content, v, unreviewed), v, bench, deadline);
  for (let round = 0; round <= MAX_EDIT_ROUNDS; round++) {
    const text = summary(file, content, v, unreviewed);
    const buttons = round < MAX_EDIT_ROUNDS ? ["取消", "改一下", "确认"] : ["取消", "确认"];
    const answer = await pullDeps().dialog.ask({ title: TITLE, prompt: text, buttons, defaultButton: "确认", cancelButton: "取消", timeoutSec: secondsLeft(deadline) });
    const failed = dialogFailure(answer);
    if (failed) return { ok: false, result: failed };
    if ((answer as { value: string }).value === "确认") return { ok: true, values: v, text };
    const edited = await editValues(v, deadline);
    if (!edited.ok) return edited;
    v = edited.value;
  }
  return { ok: false, result: { ok: false, code: "confirm_declined", error: "改了太多轮没有确认" } };
}

function confirmedResult(record: ConfirmationRecord, extra: Record<string, unknown> = {}): HandoffResult {
  const { dialog_text: _t, ...view } = record;
  return { ok: true, status: "confirmed", ...view, ...extra,
    next_action: `调 autocrew_video handoff{content_id:"${record.content_id}", aroll_path, confirmation_id:"${record.confirmation_id}", request_id}；30 分钟内有效，只能用一次。` };
}

async function validInputs(input: ConfirmInput): Promise<HandoffResult | null> {
  if (!REQUEST_ID_RE.test(input.requestId)) return handoffFail("invalid_params", "confirm 需要 request_id（1–100 位字母、数字、-、_）");
  if (!input.receiptId) return handoffFail("invalid_params", "confirm 需要 match 回执里的 receipt_id");
  if (!input.coverText.trim()) return handoffFail("invalid_params", "confirm 需要 cover_text（给弹窗的封面字初值）");
  if (!Number.isFinite(input.targetSeconds) || input.targetSeconds <= 0) return handoffFail("invalid_params", "confirm 需要正数 target_seconds");
  return null;
}

export async function confirmHandoff(input: ConfirmInput, dataDir: string): Promise<HandoffResult> {
  const bad = await validInputs(input);
  if (bad) return bad;
  const index = requestFile(dataDir, "confirm-requests", input.requestId);
  const seen = await readRecord<{ confirmation_id: string }>(index);
  if (seen) {
    const record = await readConfirmation(dataDir, seen.confirmation_id);
    if (record) return confirmedResult(record, { replayed: true });
  }
  const receipt = /^rcpt-[a-z0-9-]+$/.test(input.receiptId) ? await readReceipt(dataDir, input.receiptId) : null;
  if (!receipt) return { ok: false, code: "receipt_invalid", error: "找不到这张回执：先调 match" };
  const problem = await receiptProblem(receipt, dataDir);
  if (problem) return { ok: false, code: "receipt_invalid", error: problem };
  if (!receipt.candidates.length) return { ok: false, code: "receipt_invalid", error: "这张回执没有候选稿" };
  const aroll = await readArollInput(receipt.aroll_path);
  if (!aroll.ok) return handoffFail("aroll_invalid", aroll.reason);
  if (aroll.value.sha256 !== receipt.aroll_sha256) return { ok: false, code: "receipt_invalid", error: "认稿之后原片变了，重新 match" };
  const probed = await pullDeps().probe(aroll.value.path);
  if (!probed.ok) return handoffFail("aroll_invalid", probed.reason);
  // §12.4-C：先核回执与材料，齐了才弹窗
  const offer = await offerable(receipt, input, dataDir);
  if (!offer.ok) return offer.result;
  return confirmOnDialog(input, receipt, offer.value, dataDir, index);
}

async function confirmOnDialog(input: ConfirmInput, receipt: MatchReceipt, shown: ReceiptCandidate[], dataDir: string, index: string): Promise<HandoffResult> {
  const deadline = pullDeps().now() + CONFIRM_TIMEOUT_MS;
  const picked = await pickCandidate(receipt, shown, input, deadline);
  if (!picked.ok) return picked.result;
  const content = await getContent(picked.value.content_id, dataDir);
  if (!content || draftHash(content) !== picked.value.draft_hash) return { ok: false, code: "receipt_invalid", error: "选中的稿改过了，重新 match" };
  // 弹窗开着的几分钟里材料可能又变了：选中之后再核一遍
  const missing = await materialsProblem(content, dataDir);
  if (missing) return missing;
  const unreviewed = Boolean(picked.value.unreviewed_import);
  const decisions = await readProjectJson<ProjectDecisions>(content.id, "decisions.json", dataDir);
  const bench = decisions?.source === "founder-workbench" && decisions.draft_hash === draftHash(content) ? { cover: decisions.cover_text, seconds: decisions.target_seconds } : null;
  const done = await confirmValues(path.basename(receipt.aroll_path), content, { cover: input.coverText.trim(), seconds: Math.round(input.targetSeconds) }, unreviewed, bench, deadline);
  if (!done.ok) return done.result;
  const now = pullDeps().now();
  const record: ConfirmationRecord = {
    confirmation_id: newId("cfm"), source: "native-dialog", content_id: content.id, draft_hash: draftHash(content),
    aroll_sha256: receipt.aroll_sha256, aroll_path: receipt.aroll_path, receipt_id: receipt.receipt_id, request_id: input.requestId,
    cover_text: done.values.cover, target_seconds: done.values.seconds, clicked_at: new Date(now).toISOString(),
    expires_at: new Date(now + CONFIRMATION_TTL_MS).toISOString(), dialog_text: done.text, ...(unreviewed ? { recorded_as_is: true as const } : {}),
  };
  await writeRecord(confirmationFile(dataDir, record.confirmation_id), record);
  await writeRecord(index, { confirmation_id: record.confirmation_id });
  const next: ProjectDecisions = { draft_hash: record.draft_hash, title: content.title, cover_text: record.cover_text, platform: content.platform ?? "",
    target_seconds: record.target_seconds, confirmed_at: record.clicked_at, source: "native-dialog", confirmation_id: record.confirmation_id };
  await writeJsonAtomic(contentFile(content.id, dataDir, "decisions.json"), next);
  return confirmedResult(record);
}
