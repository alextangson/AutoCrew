/**
 * `autocrew_video confirm{receipt_id, content_id?, cover_text, target_seconds, request_id}`（P6 §12.4-C）。
 *
 * 服务端核回执与原片（有音轨、不超 30 分钟）→ 按回执前三名逐条实时核材料（审稿或导入稿条件、出处覆盖），
 * 只把材料齐的交弹窗、一条都不齐就直接拒不弹窗 → 在创始人的 Mac 上弹系统窗让他选稿（选后再核一遍材料）
 * → 再弹一个确认窗列出文件名、稿件、平台、封面字、目标时长（导入稿多一行说明；工作台已有不同的决定就并列两套值，
 * 由创始人选，不静默覆盖）。点了「确认」才由服务端写确认记录和 decisions.json（source:"native-dialog"）。
 *
 * 确认窗有「查看 / 修改…」：预览原片 / 看定稿 / 在工作台打开 / 改封面字和时长（confirm-preview.ts），预览不写记录。
 * 确认窗 5 分钟没人点 → confirm_timeout（每次预览后重新计时，总时长硬上限 20 分钟），什么都不记；取消 → confirm_declined；
 * 非 macOS / 没有图形会话 → confirm_unavailable。同一 request_id 重试返回同一条记录，不重复弹窗。
 */
import path from "node:path";
import { writeJsonAtomicMkdir as writeJsonAtomic } from "../../../storage/json-atomic.js";
import { contentFile } from "../../../storage/content-project.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import { readArollInput } from "./aroll-input.js";
import type { DialogOutcome } from "./dialog.js";
import { DIALOG_TOP_N, eligibility, readReceipt, receiptProblem, type MatchReceipt, type ReceiptCandidate } from "./match.js";
import { readProjectJson, validateCoverage, type CitationCoverage, type ProjectDecisions } from "./project-evidence.js";
import { pullDeps } from "./pull-deps.js";
import { MENU, MENU_BUTTON, previewFacts, runPreview, type MenuAction } from "./confirm-preview.js";
import { newId, pullDir, readRecord, requestFile, REQUEST_ID_RE, writeRecord } from "./pull-store.js";
import { handoffFail, type HandoffResult } from "./types.js";

export const CONFIRM_TIMEOUT_MS = 5 * 60_000;
export const CONFIRM_HARD_LIMIT_MS = 20 * 60_000;
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

/** 当前窗的截止（预览后重置）与整次 confirm 的硬上限 */
type Clock = { deadline: number; hardStop: number };

function restartClock(clock: Clock): void {
  clock.deadline = Math.min(pullDeps().now() + CONFIRM_TIMEOUT_MS, clock.hardStop);
}

function secondsLeft(clock: Clock): number {
  return Math.max(0, Math.floor((clock.deadline - pullDeps().now()) / 1000));
}

const TOO_LONG: HandoffResult = { ok: false, code: "confirm_timeout", error: "看了太久（超过 20 分钟），这次什么都没记：重新 confirm。" };

function dialogFailure(outcome: DialogOutcome<unknown>, clock?: Clock): HandoffResult | null {
  if (outcome.kind === "ok") return null;
  if (outcome.kind === "timeout" && clock && clock.deadline >= clock.hardStop) return TOO_LONG;
  if (outcome.kind === "timeout") return { ok: false, code: "confirm_timeout", error: "5 分钟内没人点弹窗，这次什么都没记。创始人在 Mac 前时再调一次 confirm。" };
  if (outcome.kind === "cancel") return { ok: false, code: "confirm_declined", error: "创始人在弹窗里点了取消，这次不交接。" };
  return { ok: false, code: "confirm_unavailable", error: `这台机器弹不出确认窗（${outcome.reason}）：请创始人在 AutoCrew 工作台确认交接信息。`,
    next_action: "停下，告诉创始人去工作台确认标题、封面字、目标时长；不要把对话里的原话当确认。" };
}

/** 弹窗是给创始人看的：平台写中文名，不露内部 id */
const PLATFORM_NAMES: Record<string, string> = { douyin: "抖音", xiaohongshu: "小红书", bilibili: "B站", wechat_video: "视频号", wechat_mp: "公众号" };
export function platformName(platform: string | null | undefined): string {
  return platform ? PLATFORM_NAMES[platform] ?? platform : "未定";
}

function label(c: ReceiptCandidate, i: number): string {
  return `${i + 1}. ${c.title}（${platformName(c.platform)}）${c.unreviewed_import ? "［导入稿］" : ""}`;
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

async function pickCandidate(receipt: MatchReceipt, shown: ReceiptCandidate[], input: ConfirmInput, clock: Clock): Promise<{ ok: true; value: ReceiptCandidate } | { ok: false; result: HandoffResult }> {
  const named = input.contentId ? shown.find((c) => c.content_id === input.contentId) : undefined;
  const items = shown.map(label);
  const picked = await pullDeps().dialog.choose({
    title: TITLE, prompt: `原片「${path.basename(receipt.aroll_path)}」录的是哪一条稿？`, items,
    ...(named ? { defaultItem: items[shown.indexOf(named)] } : {}), timeoutSec: secondsLeft(clock),
  });
  const failed = dialogFailure(picked, clock);
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

/** 确认窗里不变的上下文：弹窗前算好的几行事实 + 预览要用的路径 */
interface ConfirmCtx {
  file: string;
  arollPath: string;
  content: Content;
  unreviewed: boolean;
  facts: { aroll: string[]; draft: string[]; tail: string[] };
  dataDir: string;
}

function summary(ctx: ConfirmCtx, v: Values, notice: string | null = null): string {
  const { content, facts } = ctx;
  return [...(notice ? [`刚才打不开：${notice}`] : []), `原片：${ctx.file}`, ...facts.aroll, `稿件：${content.title}`, ...facts.draft,
    `平台：${platformName(content.platform)}`, `封面字：${v.cover}`, `目标时长：${v.seconds} 秒`, ...facts.tail,
    ...(ctx.unreviewed ? [IMPORT_LINE] : [])].join("\n");
}

async function editValues(v: Values, clock: Clock): Promise<{ ok: true; value: Values } | { ok: false; result: HandoffResult }> {
  const dialog = pullDeps().dialog;
  const cover = await dialog.input({ title: TITLE, prompt: "封面字改成：", defaultAnswer: v.cover, timeoutSec: secondsLeft(clock) });
  const coverFail = dialogFailure(cover, clock);
  if (coverFail) return { ok: false, result: coverFail };
  const secs = await dialog.input({ title: TITLE, prompt: "目标时长（秒）：", defaultAnswer: String(v.seconds), timeoutSec: secondsLeft(clock) });
  const secsFail = dialogFailure(secs, clock);
  if (secsFail) return { ok: false, result: secsFail };
  const nextCover = (cover as { value: string }).value.trim() || v.cover;
  const n = Number((secs as { value: string }).value.trim());
  return { ok: true, value: { cover: nextCover, seconds: Number.isFinite(n) && n > 0 ? Math.round(n) : v.seconds } };
}

type Confirmed = { ok: true; values: Values; text: string } | { ok: false; result: HandoffResult };

/** 工作台已有不同的决定：并列两套值，让创始人选，不静默覆盖 */
async function resolveConflict(base: string, mine: Values, bench: Values, clock: Clock): Promise<Confirmed> {
  const text = `${base}\n\n工作台已确认：封面字「${bench.cover}」，${bench.seconds} 秒\n本次：封面字「${mine.cover}」，${mine.seconds} 秒`;
  const answer = await pullDeps().dialog.ask({ title: TITLE, prompt: text, buttons: ["取消", "用工作台的", "用本次的"],
    defaultButton: "用本次的", cancelButton: "取消", timeoutSec: secondsLeft(clock) });
  const failed = dialogFailure(answer, clock);
  if (failed) return { ok: false, result: failed };
  return { ok: true, values: (answer as { value: string }).value === "用工作台的" ? bench : mine, text };
}

type MenuStep = { ok: true; values: Values; notice: string | null; edited: boolean } | { ok: false; result: HandoffResult };

/** 「查看 / 修改…」：列表取消 = 回确认窗；预览后确认窗重新计时；只有改值会变 values */
async function openMenu(ctx: ConfirmCtx, v: Values, canEdit: boolean, clock: Clock): Promise<MenuStep> {
  const actions = (Object.keys(MENU) as MenuAction[]).filter((a) => a !== "edit" || canEdit);
  const picked = await pullDeps().dialog.choose({ title: TITLE, prompt: "要看什么 / 改什么？", items: actions.map((a) => MENU[a]), timeoutSec: secondsLeft(clock) });
  if (picked.kind === "cancel") return { ok: true, values: v, notice: null, edited: false };
  const failed = dialogFailure(picked, clock);
  if (failed) return { ok: false, result: failed };
  const action = actions.find((a) => MENU[a] === (picked as { value: string }).value);
  if (!action) return { ok: true, values: v, notice: null, edited: false };
  if (action === "edit") {
    const edited = await editValues(v, clock);
    return edited.ok ? { ok: true, values: edited.value, notice: null, edited: true } : edited;
  }
  const notice = await runPreview(action, ctx.arollPath, ctx.content.id, ctx.dataDir);
  restartClock(clock);
  return { ok: true, values: v, notice, edited: false };
}

async function confirmValues(ctx: ConfirmCtx, start: Values, bench: Values | null, clock: Clock): Promise<Confirmed> {
  let v = start;
  let notice: string | null = null;
  let edits = 0;
  if (bench && (bench.cover !== v.cover || bench.seconds !== v.seconds)) return resolveConflict(summary(ctx, v), v, bench, clock);
  for (;;) {
    if (secondsLeft(clock) <= 0) return { ok: false, result: dialogFailure({ kind: "timeout" }, clock)! };
    const text = summary(ctx, v, notice);
    const answer = await pullDeps().dialog.ask({ title: TITLE, prompt: text, buttons: ["取消", MENU_BUTTON, "确认"], defaultButton: "确认", cancelButton: "取消", timeoutSec: secondsLeft(clock) });
    const failed = dialogFailure(answer, clock);
    if (failed) return { ok: false, result: failed };
    if ((answer as { value: string }).value === "确认") return { ok: true, values: v, text };
    const step = await openMenu(ctx, v, edits < MAX_EDIT_ROUNDS, clock);
    if (!step.ok) return step;
    ({ values: v, notice } = step);
    if (step.edited) edits++;
  }
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
  const began = pullDeps().now();
  const clock: Clock = { deadline: began + CONFIRM_TIMEOUT_MS, hardStop: began + CONFIRM_HARD_LIMIT_MS };
  const picked = await pickCandidate(receipt, shown, input, clock);
  if (!picked.ok) return picked.result;
  const content = await getContent(picked.value.content_id, dataDir);
  if (!content || draftHash(content) !== picked.value.draft_hash) return { ok: false, code: "receipt_invalid", error: "选中的稿改过了，重新 match" };
  // 弹窗开着的几分钟里材料可能又变了：选中之后再核一遍
  const missing = await materialsProblem(content, dataDir);
  if (missing) return missing;
  const unreviewed = Boolean(picked.value.unreviewed_import);
  const decisions = await readProjectJson<ProjectDecisions>(content.id, "decisions.json", dataDir);
  const bench = decisions?.source === "founder-workbench" && decisions.draft_hash === draftHash(content) ? { cover: decisions.cover_text, seconds: decisions.target_seconds } : null;
  const facts = await previewFacts(receipt.aroll_path, picked.value, content, dataDir);
  const ctx: ConfirmCtx = { file: path.basename(receipt.aroll_path), arollPath: receipt.aroll_path, content, unreviewed, facts, dataDir };
  const done = await confirmValues(ctx, { cover: input.coverText.trim(), seconds: Math.round(input.targetSeconds) }, bench, clock);
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
