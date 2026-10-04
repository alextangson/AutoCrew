import { projectBundle } from "./project-bundle.js";
import { assertManagedPathAvailable } from "../../../storage/storage-roots.js";
import { contentFile, resolveContentProject, safeProjectPath } from "../../../storage/content-project.js";
/**
 * `autocrew_video handoff`：Claude 会话把一条审过的稿交给 Codex 剪辑工位（P6 spec §3.4）。
 *
 * 校验顺序照 spec 字面：**重放 → 阶段 → A-roll → 路径**，写门（P6 §3.8）在只读核验之后、第一次落盘之前。
 * 重放必须在阶段门之前——交出去之后状态已是 editing、认领已在 codex 手上，同一份请求重发
 * （网络抖动、双击）不该被拒成「不能交接」或 claim_held。
 *
 * 缺料（决定、出处）在写门之前查（§13.4-D），缺什么回什么，不留认领。
 * 落盘顺序：认领转给剪辑工位（新令牌要写进交接包）→ 两份交接包 → 状态 + 交接记录同一次写。
 * 失败按 handoff-failure 的三类处理：提交前 / 确认未提交都把认领恢复成调用前那一份
 * （原持有者、原令牌），并删掉刚写的交接包；提交结果不确定就原样留着等恢复。
 * 进程在中途崩掉留下的孤儿交接包不会被覆盖（文件不可变），下一次交接自动跳到更高代次。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { transferClaim, type WriteGate } from "../../../storage/claims.js";
import { evidenceBlock, failureCode, isCommitUncertain, pendingRecovery, withClaimRestored } from "./handoff-failure.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { contentDir, getContent, transitionStatus, type Content, type ContentClaim } from "../../../storage/local-store.js";
import { probeAroll } from "../ingest.js";
import { acceptanceBlock, HANDOFF_FROM } from "./acceptance.js";
import { readProductionDoc, scriptApprovalFor } from "../../../storage/production-store.js";
import { serializeVideoLine } from "./lock.js";
import { journalBySource, markCommitted, moveArollBack, moveArollIn, readJournal, type MoveJournal } from "./aroll-move.js";
import { readArollInput } from "./aroll-input.js";
import type { ConfirmationRecord } from "./confirm.js";
import { announceHandoff } from "./confirm-preview.js";
import { pullDeps } from "./pull-deps.js";
import { checkConfirmation, dropRequestRecord, markConfirmation, requestReplay, saveRequestRecord, validRequestId, type HandoffRequestRecord } from "./pull-handoff.js";
import { hashClaimToken } from "../../../storage/claim-token.js";
import { arollLockOf, putArollLock, releaseArollLock, withGlobalHandoffLock } from "./pull-store.js";
import {
  buildManifest,
  dispatchText,
  manifestHash,
  MAX_HANDOFF_BYTES,
  renderHandoffFile,
  sha256File,
  type HandoffFileInput,
} from "./manifest.js";
import { claimProjectDir, defaultProjectName, resolveProjectRoot, SCRIPT_DIR } from "./paths.js";
import { expandHome, usableRoots, type ProjectRoots } from "./roots.js";
import { handoffFail, type HandoffManifest, type HandoffResult, type VideoHandoffRecord } from "./types.js";

/** 剪辑工位的宿主名（命名 token 的主体）：交接把认领转给它 */
export const EDITOR_HOST = "codex";

export interface HandoffInput {
  contentId: string;
  arollPath: string;
  projectRoot?: string;
  notes?: string;
  host: string;
  session?: string;
  claimToken?: string;
  /** Codex 发起的交接（P6 §12.4-D）：服务端确认记录 + 本次请求号 */
  confirmationId?: string;
  requestId?: string;
}

export interface HandoffContext {
  dataDir: string;
  /** 写门（P6 §3.8）：重放与只读核验之后、第一次落盘之前才过；放行时 grant 里的令牌要随回执交回 */
  gate: () => Promise<WriteGate>;
}

export type Grant = { claim_token?: string };

interface Plan {
  content: Content;
  arollPath: string;
  projectRoot: string;
  base: Omit<HandoffManifest, "generation">;
}

type Planned = { ok: true; plan: Plan } | { ok: false; result: HandoffResult };

export function handedOffResult(record: VideoHandoffRecord, extra: Record<string, unknown> = {}): HandoffResult {
  return {
    ok: true,
    status: "handed_off",
    content_id: record.content_id,
    generation: record.generation,
    manifest_hash: record.hash,
    project_root: record.project_root,
    handoff_path: record.handoff_path,
    project_handoff_path: record.project_handoff_path,
    dispatch_text: dispatchText(record, record.project_handoff_path),
    note: "认领已转给剪辑工位（codex）；在 project_root 读取 AGENTS.md 与当前交接包。登记回来之前本稿不可改。",
    ...extra,
  };
}

/** 算出这次请求对应的清单（代次待定）：重放比对与正式交接用同一份。原片全文件哈希在这里重算 */
async function planHandoff(content: Content, input: HandoffInput, roots: ProjectRoots, dataDir: string): Promise<Planned> {
  const aroll = await readArollInput(input.arollPath);
  if (!aroll.ok) return { ok: false, result: handoffFail("aroll_invalid", aroll.reason) };
  const arollPath = aroll.value.path;
  const binding = resolveContentProject(content.id, dataDir);
  if (binding && input.projectRoot && path.resolve(input.projectRoot) !== path.resolve(binding.project_root)) return { ok: false, result: handoffFail("project_binding_conflict", "必须复用写稿时的项目目录") };
  const requested = binding?.project_root || input.projectRoot?.trim()
    || content.video?.handoff?.project_root
    || path.join(roots.roots[0], defaultProjectName(content.title));
  const resolved = await resolveProjectRoot(requested, roots);
  if (!resolved.ok) return { ok: false, result: resolved.result };
  const base = {
    content_id: content.id,
    draft_hash: draftHash(content),
    aroll_sha256: aroll.value.sha256,
    project_root: resolved.value,
    notes: binding ? (input.notes ?? "") : (input.notes ?? "").trim(),
  };
  return { ok: true, plan: { content, arollPath, projectRoot: resolved.value, base } };
}

/** 重放：当前交接未撤回、状态已离开可交接态、同一份清单 → 原样返回（不重写任何东西） */
async function replayOf(content: Content, base: Plan["base"], dataDir: string): Promise<VideoHandoffRecord | null> {
  const current = content.video?.handoff;
  if (!current || (content.video?.revoked ?? []).includes(current.hash)) return null;
  if (HANDOFF_FROM.has(content.status)) return null;
  const manifest = { ...base, generation: current.generation };
  const bundle = await projectBundle(content, manifest, dataDir);
  return manifestHash(bundle?.manifest ?? manifest) === current.hash ? current : null;
}

function handoffDir(contentId: string, dataDir: string): string {
  return contentFile(contentId, dataDir, "handoff");
}

/** 下一代次 = 已提交代次与盘上已有交接包代次的最大值 + 1（孤儿包占住的号不复用） */
async function nextGeneration(content: Content, dataDir: string): Promise<number> {
  let max = content.video?.handoff?.generation ?? 0;
  const binding = resolveContentProject(content.id, dataDir);
  if (binding) {
    // 空的 01-script/handoff 常被同步盘/迁移丢掉，手动导入的项目也没有它：缺目录 = 还没有旧代次
    for (const name of await readdirOrEmpty(path.join(binding.project_root, "01-script/handoff"))) {
      const m = /^g(\d+)$/.exec(name); if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }
  for (const name of await readdirOrEmpty(handoffDir(content.id, dataDir))) {
    const m = /^editor-g(\d+)\.md$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}

/** 不可变写：独占创建；已存在且内容不同 → null（冲突），相同 → false（没新建） */
async function writeImmutable(file: string, text: string): Promise<boolean | null> {
  assertManagedPathAvailable(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, text, { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return (await fs.readFile(file, "utf-8")) === text ? false : null;
  }
}

export async function handoffVideo(input: HandoffInput, ctx: HandoffContext): Promise<HandoffResult> {
  // 全局交接锁在外、稿件交接线锁在里：原片锁的「查 + 占」跨稿件原子
  return withGlobalHandoffLock(() => serializeVideoLine(input.contentId, () => handoffLocked(input, ctx)));
}

/** Codex 发起的交接：先按请求身份重放（不读源文件），再核确认记录 */
async function pullGate(input: HandoffInput, content: Content, dataDir: string): Promise<{ ok: true; value?: ConfirmationRecord } | { ok: false; result: HandoffResult }> {
  if (!input.confirmationId) {
    if (input.host !== EDITOR_HOST) return { ok: true };
    return { ok: false, result: handoffFail("confirmation_required", "剪辑工位发起交接必须带 confirmation_id：先 match、再 confirm 让创始人在 Mac 弹窗里点确认") };
  }
  if (!resolveContentProject(content.id, dataDir)) {
    return { ok: false, result: handoffFail("project_migration_required", "这条稿还没迁移到项目（v2）：只能由 Claude 写稿会话推送交接") };
  }
  return checkConfirmation(input.confirmationId, content, dataDir);
}

function inUse(holder: { content_id: string; generation: number }): HandoffResult {
  return handoffFail("aroll_in_use", "这段原片已经交给另一条稿了：同一段原片同时只归一条未撤回交接", { holder: { content_id: holder.content_id, generation: holder.generation } });
}

/** 读源文件之前先认锁：原片可能已被别的交接挪进项目，原路径空了 */
async function arollTaken(dataDir: string, contentId: string, sha: string | undefined, arollPath: string): Promise<HandoffResult | null> {
  const lock = sha ? await arollLockOf(dataDir, sha) : null;
  if (lock && lock.content_id !== contentId) return inUse(lock);
  const moved = arollPath ? await journalBySource(dataDir, path.resolve(expandHome(arollPath.trim()))) : null;
  return moved && moved.content_id !== contentId ? inUse(moved) : null;
}

/** 推送路重放：原片已经挪进项目、原路径空了，同一份请求重发照样认（§13.8 #3：先查记录、再读源文件） */
async function movedSourceReplay(content: Content, input: HandoffInput): Promise<VideoHandoffRecord | null> {
  const current = content.video?.handoff;
  if (input.confirmationId || !current?.aroll_source_path || HANDOFF_FROM.has(content.status)) return null;
  if ((content.video?.revoked ?? []).includes(current.hash)) return null;
  const asked = path.resolve(expandHome(input.arollPath.trim()));
  if (asked !== current.aroll_source_path) return null;
  return (await fs.lstat(asked).then(() => true, () => false)) ? null : current;
}

async function handoffLocked(input: HandoffInput, ctx: HandoffContext): Promise<HandoffResult> {
  if (input.confirmationId) {
    if (!validRequestId(input.requestId)) return handoffFail("invalid_params", "带 confirmation_id 的交接需要 request_id（1–100 位字母、数字、-、_）");
    const replayed = await requestReplay(ctx.dataDir, input.requestId, input.confirmationId, input.host);
    if (replayed) return replayed;
  }
  const content = await getContent(input.contentId, ctx.dataDir);
  if (!content) return handoffFail("invalid_params", `稿件不存在：${input.contentId}`);
  const pulled = await pullGate(input, content, ctx.dataDir);
  if (!pulled.ok) return pulled.result;
  const early = await movedSourceReplay(content, input);
  if (early) return handedOffResult(early, { replayed: true, content_status: content.status });
  const confirmation = pulled.value;
  const roots = await usableRoots(ctx.dataDir);
  if (!roots.ok) return roots.result;
  const arollPath = input.arollPath || confirmation?.aroll_path || "";
  const taken = await arollTaken(ctx.dataDir, content.id, confirmation?.aroll_sha256, arollPath);
  if (taken) return taken;
  const planned = await planHandoff(content, { ...input, arollPath }, roots.value, ctx.dataDir);
  if (!planned.ok) return planned.result;
  if (confirmation && planned.plan.base.aroll_sha256 !== confirmation.aroll_sha256) {
    await markConfirmation(ctx.dataDir, confirmation, { voided_at: new Date().toISOString() });
    return handoffFail("confirmation_invalid", "原片和弹窗确认时不是同一个文件了：这次确认作废，重新 match / confirm");
  }
  const replay = await replayOf(content, planned.plan.base, ctx.dataDir);
  if (replay) return handedOffResult(replay, { replayed: true, content_status: content.status });
  return handoffChecked(content, input, ctx, planned.plan, confirmation);
}

async function handoffChecked(content: Content, input: HandoffInput, ctx: HandoffContext, plan: Plan, confirmation?: ConfirmationRecord): Promise<HandoffResult> {
  const doc = content.draftFinal ? await readProductionDoc(content.id, ctx.dataDir) : null;
  const scriptApproved = Boolean(doc && scriptApprovalFor(doc, content.body));
  const blocked = acceptanceBlock(content, confirmation, plan.base.aroll_sha256, scriptApproved) ?? await evidenceBlock(content, ctx.dataDir);
  if (blocked) return blocked;
  const probed = await probeAroll(plan.arollPath);
  if (!probed.ok) return handoffFail("aroll_invalid", probed.reason);
  const lock = await arollLockOf(ctx.dataDir, plan.base.aroll_sha256);
  if (lock && lock.content_id !== content.id) return inUse(lock);
  // 写门放在只读核验之后、第一次落盘之前：被拒的请求不留认领这种副作用
  const prior = content.claim;
  const gate = await ctx.gate();
  if ("denied" in gate) return gate.denied;
  const held = { contentId: content.id, prior, heldToken: gate.grant.claim_token ?? input.claimToken, dataDir: ctx.dataDir };
  try {
    return await commitHandoff(plan, input, ctx, gate.grant, prior, confirmation);
  } catch (err) {
    // 认领转交之前抛出的故障（算代次、打包、占目录）：提交前失败，认领恢复原样
    if (isCommitUncertain(err)) return pendingRecovery(err);
    const code = failureCode(err, "handoff_rejected");
    await releaseArollLock(ctx.dataDir, plan.base.aroll_sha256, content.id);
    return withClaimRestored(handoffFail(code, err instanceof Error ? err.message : String(err)), "handoff_rejected", held);
  }
}

interface Prepared {
  bundle?: Record<string, string>;
  manifest: HandoffManifest;
  record: VideoHandoffRecord;
  fileInput: HandoffFileInput;
}

async function prepareCommit(plan: Plan, input: HandoffInput, dataDir: string): Promise<Prepared> {
  const generation = await nextGeneration(plan.content, dataDir);
  const bundle = await projectBundle(plan.content, buildManifest({ ...plan.base, generation }), dataDir);
  const manifest = bundle?.manifest ?? buildManifest({ ...plan.base, generation });
  const hash = manifestHash(manifest);
  const record: VideoHandoffRecord = {
    ...manifest,
    hash,
    at: new Date().toISOString(),
    by: input.host,
    ...(input.session ? { session: input.session } : {}),
    version: plan.content.versions?.length ?? 1,
    aroll_path: plan.arollPath,
    handoff_path: path.join(handoffDir(plan.content.id, dataDir), `editor-g${generation}.md`),
    project_handoff_path: path.join(plan.projectRoot, SCRIPT_DIR, `autocrew-handoff-g${generation}.md`),
  };
  if (bundle) {
    const bundleFile = path.join(plan.projectRoot, `01-script/handoff/g${String(generation).padStart(4, "0")}/handoff.md`);
    record.handoff_path = bundleFile; record.project_handoff_path = bundleFile;
    record.aroll_path = path.join(plan.projectRoot, "02-aroll", path.basename(plan.arollPath));
  }
  const fileInput = { title: plan.content.title, manifest, hash, body: plan.content.body, arollPath: plan.arollPath };
  return { manifest, record, fileInput, ...(bundle ? { bundle: bundle.files } : {}) };
}

async function commitHandoff(plan: Plan, input: HandoffInput, ctx: HandoffContext, grant: Grant, prior: ContentClaim | undefined, confirmation?: ConfirmationRecord): Promise<HandoffResult> {
  const held = { contentId: plan.content.id, prior, heldToken: grant.claim_token ?? input.claimToken, dataDir: ctx.dataDir };
  const prepared = await prepareCommit(plan, input, ctx.dataDir);
  // 令牌长度固定量级，拿占位令牌先量一次：超限就别动认领
  const sized = renderHandoffFile({ ...prepared.fileInput, claimToken: "clm-0000000000000-00000000" });
  if (!prepared.bundle && Buffer.byteLength(sized) > MAX_HANDOFF_BYTES) {
    return withClaimRestored(handoffFail("handoff_too_large", `交接包超过 ${MAX_HANDOFF_BYTES / 1024} KB（正文或备注太长）`), "handoff_rejected", held);
  }
  const owned = await claimProjectDir(plan.projectRoot, plan.content.id);
  if (!owned.ok) return withClaimRestored(owned.result, "handoff_rejected", held);
  const sha = plan.base.aroll_sha256;
  await putArollLock(ctx.dataDir, sha, { content_id: plan.content.id, generation: prepared.record.generation, ...(input.requestId ? { request_id: input.requestId } : {}), at: new Date().toISOString() });
  const moved = await transferClaim(plan.content.id, {
    token: grant.claim_token ?? input.claimToken,
    host: input.host,
    toEmployee: "editor",
    toHost: EDITOR_HOST,
    note: `交接剪辑 g${prepared.record.generation}`,
    heartbeat: true,
  }, ctx.dataDir);
  if (!moved.ok) {
    await releaseArollLock(ctx.dataDir, sha, plan.content.id);
    return withClaimRestored(handoffFail("handoff_rejected", moved.error, moved.holder ? { holder: moved.holder } : {}), "handoff_rejected", held);
  }
  return landHandoff(plan, input, ctx, prepared, { ...held, heldToken: moved.claim.token }, confirmation);
}

/** 令牌直接交给这次交接的调用方（P6 §12.4-D）：Codex 发起 = 它自己拿着；Claude 推送 = 随派工交给接手的那个 Codex 会话 */
function requestRecord(plan: Plan, requestId: string, confirmation: ConfirmationRecord, record: VideoHandoffRecord, token: string, result: HandoffResult, pending: boolean): HandoffRequestRecord {
  return { request_id: requestId, confirmation_id: confirmation.confirmation_id, content_id: plan.content.id, generation: record.generation,
    manifest_hash: record.hash, claim_token_hash: hashClaimToken(token), at: new Date(pullDeps().now()).toISOString(), result, ...(pending ? { pending: true } : {}) };
}

async function committed(plan: Plan, input: HandoffInput, ctx: HandoffContext, record: VideoHandoffRecord, token: string, confirmation: ConfirmationRecord | undefined, base: HandoffResult): Promise<HandoffResult> {
  if (confirmation && input.requestId) {
    await markConfirmation(ctx.dataDir, confirmation, { used_at: new Date().toISOString(), used_by_request: input.requestId });
    await saveRequestRecord(ctx.dataDir, requestRecord(plan, input.requestId, confirmation, record, token, base, false), token);
  }
  if (input.host === EDITOR_HOST) return { ...base, claim_token: token, note: "交接已提交，剪辑认领在你手上：后续 report / register 带这枚 claim_token，每 10 分钟用 report 报一次进度（心跳）。令牌不要贴进聊天或写进文件。" };
  // v1 老路的令牌照旧写在交接包里，回执不再重复
  if (!record.v2) return base;
  return { ...base, editor_claim_token: token, note: "交接已提交。editor_claim_token 是剪辑认领：只随派工交给接手的那一个 Codex 会话，不写进任何文件；登记回来之前本稿不可改。" };
}

/** 写两份交接包 → 状态与记录同一次落盘；确认没提交就删包、认领恢复原样、状态不动 */
async function landHandoff(
  plan: Plan,
  input: HandoffInput,
  ctx: HandoffContext,
  prepared: Prepared,
  held: Parameters<typeof withClaimRestored>[2] & { heldToken: string },
  confirmation?: ConfirmationRecord,
): Promise<HandoffResult> {
  const { record } = prepared;
  const editorToken = held.heldToken;
  const text = renderHandoffFile({ ...prepared.fileInput, claimToken: editorToken });
  const created: string[] = [];
  let failure: HandoffResult;
  try {
    const journal = prepared.bundle ? await moveIntoProject(plan, input, record, ctx.dataDir) : null;
    const files = prepared.bundle ? Object.entries(prepared.bundle).map(([p, t]) => [safeProjectPath(plan.projectRoot, p), t]) : [[record.handoff_path, text], [record.project_handoff_path, text]];
    for (const [file, body] of files) {
      const wrote = await writeImmutable(file, body);
      if (wrote === null) throw Object.assign(new Error(`交接包已存在且内容不同，不覆盖：${file}`), { code: "handoff_file_exists" });
      if (wrote) created.push(file);
    }
    const base = handedOffResult(record, { content_status: "editing", ...arollNote(journal) });
    // 请求记录先于提交落盘：崩在提交之后、回执之前，重试凭它按冻结结果交还同一枚令牌
    if (confirmation && input.requestId) await saveRequestRecord(ctx.dataDir, requestRecord(plan, input.requestId, confirmation, record, editorToken, base, true), editorToken);
    pullDeps().checkpoint("handoff_before_commit");
    const moved = await transitionStatus(plan.content.id, "editing", {
      expectedStatus: plan.content.status,
      expectedDraft: { title: plan.content.title, body: plan.content.body, platform: plan.content.platform },
      host: input.host,
      viaHandoff: true,
      patch: (current) => ({ video: { ...current.video, handoff: record } }),
    }, ctx.dataDir);
    if (moved.ok) {
      pullDeps().checkpoint("handoff_committed");
      if (journal) await markCommitted(ctx.dataDir, journal).catch(() => undefined);
      // 真正提交（非重放）才弹一次不阻塞的通知窗；弹不出来只进 warnings
      const done = await committed(plan, input, ctx, record, editorToken, confirmation, base);
      return { ...done, ...(await announceHandoff(plan.content.id, plan.content.title)) };
    }
    failure = handoffFail("handoff_not_committed", `状态没推进：${moved.error ?? "未知原因"}`);
  } catch (err) {
    // 结果不确定：交接包、认领、事务日志原样留着，等重启核定
    if (isCommitUncertain(err)) return pendingRecovery(err);
    failure = handoffFail(failureCode(err, "handoff_not_committed"), err instanceof Error ? err.message : String(err));
  }
  for (const file of created) await fs.rm(file, { force: true }).catch(() => undefined);
  if (confirmation && input.requestId) await dropRequestRecord(ctx.dataDir, input.requestId).catch(() => undefined);
  const aroll = await putArollBack(plan, record, ctx.dataDir);
  return withClaimRestored({ ...failure, ...aroll }, "handoff_not_committed", held);
}

/** 挪进 `02-aroll/<原文件名>`：日志先落盘再动文件（aroll-move.ts） */
async function moveIntoProject(plan: Plan, input: HandoffInput, record: VideoHandoffRecord, dataDir: string): Promise<MoveJournal> {
  const dir = path.join(plan.projectRoot, "02-aroll");
  assertManagedPathAvailable(dir);
  const journal = await moveArollIn(dataDir, { ...(input.requestId ? { request_id: input.requestId } : {}), content_id: plan.content.id,
    generation: record.generation, source: plan.arollPath, sha256: record.aroll_sha256 }, dir);
  record.aroll_path = journal.target;
  record.aroll_source_path = plan.arollPath;
  return journal;
}

function arollNote(journal: MoveJournal | null): Record<string, unknown> {
  if (!journal) return {};
  return { aroll_moved_to: journal.target, ...(journal.source_left ? { aroll_original_left_at: journal.source,
    aroll_note: `原片已复制进项目并校验一致，但 Downloads 里的原件没删掉，还在 ${journal.source}` } : {}) };
}

/** 确认没提交：按日志把原片挪回原处，校验后才释放原片锁；挪不回就留着锁和日志，重启再试 */
async function putArollBack(plan: Plan, record: VideoHandoffRecord, dataDir: string): Promise<Record<string, unknown>> {
  const journal = await readJournal(dataDir, record.aroll_sha256);
  if (!journal || journal.content_id !== plan.content.id || journal.generation !== record.generation) {
    await releaseArollLock(dataDir, record.aroll_sha256, plan.content.id);
    return {};
  }
  try {
    return { aroll_restored_to: await moveArollBack(dataDir, journal, pullDeps().downloadsDir) };
  } catch (err) {
    return { aroll_restore_failed: `${err instanceof Error ? err.message : String(err)}；原片锁保留，重启 AutoCrew 后自动再试` };
  }
}
