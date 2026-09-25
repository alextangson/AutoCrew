/**
 * 宿主交稿（P3 spec §5.3）——把写手循环翻过来的另一半：**收稿**。
 *
 * 一条状态机，全部走同一份门禁代码（`runAllGates` + `submitDepsFor`）：
 *
 *   长度门（在 `validateSubmitArgs` 里）→ 格式门 / 数字门 / 质量门
 *     ├─ 有未过项且修复轮有余额 → repair（稿不落盘，计数 +1）
 *     ├─ 硬门未过且余额用尽     → blocked → 稿件 needs_evidence
 *     └─ 全过 → 人味化 → 落稿 → 只审不修
 *           ├─ review=host（缺省）→ awaiting_host_review，**审稿材料随回执给出**（P6 §3.7，省一次 review_desk pack）
 *           ├─ review=none / 审稿线没配 → 当场 accepted_unreviewed（这两种是瞬时判断，不必转后台）
 *           └─ review=engine → reviewing（**立刻返回**），审稿在 `writer-review.ts` 的后台跑，
 *               终态由 `submit_status` 取——审一遍实测 161 秒，宿主 60 秒就掐调用。
 *
 * 草稿就绪后宿主要再改：带 `revision_of`（当前稿指纹）直接交，开一个修订周期（`writer-revision.ts`），不重领包。
 *
 * 三条纪律：
 * 1. **`status` 永远是返回体第一个字段**（§8 防呆）：人设要求宿主先看它。
 * 2. **同 `attempt` 同载荷重放不产生任何副作用**：原样还回上次结果，不扣修复轮、不推状态；
 *    同号不同载荷报 `attempt_conflict`——绝不静默丢掉新正文（P6 §3.7）。
 * 3. **降级必须可见**：审稿失败不静默跳过，落 `review.status = skipped` + 人话原因 + `lastError`。
 */
import { createHash, randomUUID } from "node:crypto";
import { HARD_GATE_CHECKS, type GateFailure } from "../modules/writing/quality-gate.js";
import {
  assembleAndHumanize,
  runAllGates,
  validateSubmitArgs,
  type SubmitPayload,
} from "../modules/writing/script-payload.js";
import { submitDepsFor } from "../modules/writing/generate-script.js";
import { restoreEvidenceLedger, type EvidenceLedger } from "../modules/research/evidence-ledger.js";
import {
  getContent,
  transitionStatus,
  updateContent,
  type Content,
  type ContentStatus,
  type ContentUpdates,
} from "../storage/local-store.js";
import {
  isReadyPack,
  packGate,
  packNotReadyError,
  readPack,
  stalePackError,
  submissionVisibility,
  writerProgress,
  writePack,
  type PendingReview,
  type ReadyPack,
  type SubmitPhase,
  type WritingPackFile,
} from "./writer-pack.js";
import {
  resumeReview,
  reviewLine,
  settleReview,
  startReview,
  REVIEWING_NOTE,
  REVIEW_NONE_REASON,
  type ReviewJob,
  type ReviewRunDeps,
} from "./writer-review.js";
import { hostReviewPack } from "./host-review.js";
import { directRevisionRefusal, openRevisionCycle, takeRevisionVersion } from "./writer-revision.js";

export type SubmitFailure = { ok: false; error: string } & Record<string, unknown>;
export type SubmitResult = ({ status: SubmitPhase } & Record<string, unknown>) | SubmitFailure;

export interface SubmitArgs {
  contentId: string;
  packId: string;
  attempt: number;
  title: string;
  hook?: string;
  body: string;
  cta?: string;
  hashtags?: unknown;
  /** 缺省host：宿主领取同一份审稿材料完成点评，只有显式engine才调用API。 */
  review?: "host" | "engine" | "none";
  /** 草稿就绪后直接修订：宿主手上那一版的 draft_hash（与 editorial 同一算法） */
  revisionOf?: string;
  /** 宿主自己的修订说明：只进版本记录（source:"host"），不是用户反馈 */
  revisionNote?: string;
  host: string;
}

export type SubmitDeps = ReviewRunDeps;

const WRITABLE: ContentStatus[] = ["drafting", "revision"];

function fail(error: string, extra: Record<string, unknown> = {}): SubmitFailure {
  return { ok: false, error, ...extra };
}

// ─── 载荷指纹（重放 vs 冲突）────────────────────────────────────────────────────

/** writing-pack.json 上每个 attempt 的载荷指纹；单独一格，审稿落终态改写 attempt 记录时不会被抹掉 */
type PayloadHashes = { payloadHashes?: Record<string, string> };

function payloadDigest(args: SubmitArgs): string {
  return createHash("sha256").update(JSON.stringify([args.title, args.hook ?? "", args.body, args.cta ?? "", args.hashtags ?? []])).digest("hex");
}

function notePayload(pack: WritingPackFile, args: SubmitArgs): void {
  const holder = pack as WritingPackFile & PayloadHashes;
  holder.payloadHashes = { ...holder.payloadHashes, [String(args.attempt)]: payloadDigest(args) };
}

function highestAttempt(pack: WritingPackFile): number {
  return Math.max(0, ...Object.keys(pack.attempts).map(Number).filter(Number.isInteger));
}

function draftHashOf(title: string, body: string, platform?: string): string {
  return createHash("sha256").update(JSON.stringify([title, body, platform])).digest("hex");
}

// ─── 前置校验 ─────────────────────────────────────────────────────────────────

type Loaded = { content: Content; pack: ReadyPack; opensCycle: boolean };

async function loadForSubmit(
  args: SubmitArgs,
  dataDir: string,
  deps: SubmitDeps,
): Promise<Loaded | SubmitFailure | { replay: Record<string, unknown> }> {
  const content = await getContent(args.contentId, dataDir);
  if (!content) return fail(`稿件不存在：${args.contentId}`);
  // packId 是写手侧的 fencing token（§5.2）：再领一次包就把旧号作废，迟到的提交必须被拒
  if (content.pack?.packId !== args.packId) return fail(stalePackError(content.pack?.packId, args.packId));
  const pack = await readPack(args.contentId, dataDir);
  if (!pack || pack.packId !== args.packId) return fail(stalePackError(pack?.packId, args.packId));
  // 备料没落地的包不收稿：门禁判据、审稿材料、账本全在 `context` 里，半份包过的门等于没过
  if (!isReadyPack(pack)) return fail(packNotReadyError(pack));

  if (!Number.isInteger(args.attempt) || args.attempt < 1) {
    return fail(`attempt 必须是 ≥1 的整数（每提交一次加一），收到的是 ${String(args.attempt)}`);
  }
  // 盘上写着「在审」但进程里没人在跑（重启留下的）：顺手重跑，别让这一稿卡死在中间态
  await resumeReview(args.contentId, pack, dataDir, deps);
  const replay = await replayOf(args, content, pack, dataDir);
  return replay ?? admissible(args, content, pack);
}

/** 同号到达：同载荷原样还回（网络重发、宿主重试都会撞到这里），不同载荷报 `attempt_conflict` */
async function replayOf(
  args: SubmitArgs,
  content: Content,
  pack: ReadyPack,
  dataDir: string,
): Promise<SubmitFailure | { replay: Record<string, unknown> } | null> {
  const done = pack.attempts[String(args.attempt)];
  if (!done) return null;
  if (done.hostReview) {
    const stale = draftHashOf(content.title, content.body, content.platform) !== done.hostReview.draftHash || args.attempt !== highestAttempt(pack);
    if (stale) return fail("stale_review: 稿件或提交版本已经变化，不能沿用旧审稿回执；请重新领取当前稿的写作包、提交并审阅");
  }
  // 升级前的记录没有指纹：无从证明冲突，按老规矩当重放
  const recorded = (pack as ReadyPack & PayloadHashes).payloadHashes?.[String(args.attempt)];
  if (recorded && recorded !== payloadDigest(args)) {
    const current = highestAttempt(pack);
    return fail(`attempt ${args.attempt} 已经收过另一份稿，同号只用于原样重试；新正文请用 attempt ${current + 1} 交（本次未保存）。`, {
      code: "attempt_conflict",
      current_attempt: current,
      next_action: { tool: "autocrew_writer", params: { action: "submit", content_id: args.contentId, pack_id: args.packId, attempt: current + 1 }, message: "用新的 attempt 重交这份正文；草稿已就绪时还要带 revision_of（当前稿 draft_hash）。" },
    });
  }
  const replay = { ...submissionVisibility(pack, done.result), replayed: true, replayed_at: done.at };
  // 等宿主审稿的那一稿：审稿材料随重放一起还回去（同一个 review_pack_id），不必再调 review_desk pack
  if (done.status !== "awaiting_host_review") return { replay };
  return { replay: { ...replay, review_pack: await hostReviewPack(args.contentId, pack, args.host, dataDir) } };
}

function notWritable(content: Content): string {
  return content.status === "draft_ready"
    ? `这篇已是「draft_ready」，普通交稿不收稿：宿主直接改稿请带 revision_of（当前稿 draft_hash）并把 attempt 加一；创作者有新意见时先 autocrew_editorial feedback（${content.id}）`
    : `这篇现在是「${content.status}」，不收稿——只有写作中 / 修订中的稿能提交（${content.id}）`;
}

/** 状态门放在重放之后：稿子已经 draft_ready 时宿主重发同一 attempt，要拿回「已收下」而不是「不收稿」 */
function admissible(args: SubmitArgs, content: Content, pack: ReadyPack): Loaded | SubmitFailure {
  const opensCycle = content.status === "draft_ready" && Boolean(args.revisionOf);
  if (!WRITABLE.includes(content.status) && !opensCycle) return fail(notWritable(content));
  // 上一稿还在审：这时候收下一版就是同一篇稿两遍审稿抢着推状态，先让他等结果
  const pendingAttempt = Object.entries(pack.attempts).find(([, rec]) => rec.status === "reviewing" || rec.status === "awaiting_host_review");
  if (pendingAttempt) return fail(pendingAttempt[1].status === "awaiting_host_review"
    ? `上一稿（attempt ${pendingAttempt[0]}）等待宿主审稿，先 autocrew_review_desk pack{content_id} 领取材料并提交结论`
    : `上一稿（attempt ${pendingAttempt[0]}）还在审，先 submit_status 等结果`);
  const highest = highestAttempt(pack);
  if (args.attempt < highest) {
    return fail(`过期重试：这篇已经收到过 attempt ${highest}，你交的是 ${args.attempt}——改用 ${highest + 1} 重交`);
  }
  if (args.revisionOf) {
    const refused = directRevisionRefusal(content, pack, args.revisionOf, opensCycle);
    if (refused) return refused;
  }
  return { content, pack, opensCycle };
}

// ─── 落盘 ─────────────────────────────────────────────────────────────────────

async function record(
  args: SubmitArgs,
  pack: WritingPackFile,
  result: { status: SubmitPhase } & Record<string, unknown>,
  dataDir: string,
  /** 只有 `reviewing` 带它：后台那一遍的入参，进程重启后靠它重跑 */
  pending?: PendingReview,
): Promise<{ status: SubmitPhase } & Record<string, unknown>> {
  const at = new Date().toISOString();
  pack.attempts[String(args.attempt)] = { status: result.status, at, startedAt: at, result, ...(pending ? { pending } : {}) };
  notePayload(pack, args);
  await writePack(args.contentId, pack, dataDir);
  return result;
}

type DraftExtra = {
  ledger: EvidenceLedger;
  needsHuman: string[];
  versionNote: string;
  reviewPending?: boolean;
  /** 修订周期第一次落盘的版本：来源与宿主的修订说明（`takeRevisionVersion`） */
  revision?: ReturnType<typeof takeRevisionVersion>;
};

/** 交稿即落盘（不管后面审稿结果如何）：审稿要跑几分钟，这中间稿子不许只存在于内存里 */
async function persistDraft(
  args: SubmitArgs,
  content: Content,
  payload: SubmitPayload,
  humanizedText: string,
  extra: DraftExtra,
  dataDir: string,
): Promise<void> {
  const version: ContentUpdates = extra.revision
    ? { _versionNote: extra.revision.note, _versionMeta: extra.revision.meta }
    : { _versionNote: extra.versionNote };
  await updateContent(
    args.contentId,
    {
      title: payload.title,
      body: humanizedText,
      hashtags: payload.hashtags.map((t) => t.trim()).filter(Boolean),
      lastError: null,
      unverifiedNumbers: extra.needsHuman,
      evidenceLedger: extra.ledger.snapshot(),
      writtenBy: { kind: "host", host: args.host },
      pack: { ...content.pack!, submittedAt: new Date().toISOString(), reviewMode: args.review ?? "host", reviewPending: extra.reviewPending ?? false },
      ...version,
    },
    dataDir,
  );
}

// ─── 硬门拦下 ─────────────────────────────────────────────────────────────────

/** 硬门打回文案里那份「哪些数字没据」的清单（同 finalizeBlocked 的取法） */
function blockedNumbers(failures: GateFailure[]): string[] {
  const failure = failures.find((f) => f.check === "unverified_numbers");
  if (!failure) return [];
  return failure.detail
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

type GateOutcome = { payload: SubmitPayload; failures: GateFailure[]; needsHuman: string[]; ledger: EvidenceLedger };

async function finalizeBlocked(
  args: SubmitArgs,
  content: Content,
  pack: ReadyPack,
  gates: GateOutcome,
  hard: GateFailure[],
  dataDir: string,
): Promise<{ status: SubmitPhase } & Record<string, unknown>> {
  const humanizedText = assembleAndHumanize(gates.payload);
  const unverified = [...blockedNumbers(gates.failures), ...gates.needsHuman];
  const reason = hard[0]?.detail ?? "硬门未通过";
  await persistDraft(args, content, gates.payload, humanizedText, {
    ledger: gates.ledger,
    needsHuman: unverified,
    versionNote: `${args.host} 交稿被硬门拦下（缺证据，未转草稿）`,
    revision: takeRevisionVersion(pack, args.host, args.attempt),
  }, dataDir);
  await updateContent(args.contentId, { blockedReason: reason }, dataDir);
  const moved = await transitionStatus(args.contentId, "needs_evidence", {}, dataDir);
  return {
    status: "blocked",
    saved: true,
    quality_status: "blocked",
    needs_attention: true,
    reason,
    unverified_numbers: unverified,
    content_status: moved.ok ? "needs_evidence" : content.status,
    next_action: {
      action: "supply_evidence",
      message: "补充证据或移除无依据的事实数字，再重新准备写作包；保留当前草稿供核对。",
    },
    human_next_step: "当前草稿缺少事实依据，尚不能作为通过审核的成稿；需要你掌握的一手信息时，宿主应明确列出缺口。",
    note: "修复轮已用尽，硬门仍未过——稿件标「缺证据」。补上证据编号或删掉这些数字之后，重新 pack 再写。",
    ...(moved.ok ? {} : { warning: `稿件状态推不动：${moved.error ?? "未推进"}（正文已保存）` }),
  };
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

/**
 * 这一稿要不要转后台审：`review=none` 与「审稿线读不出来」都是**瞬时**判断，当场收口更诚实；
 * 其余一律转后台——审一遍要跑几分钟，同步等就是让宿主在 60 秒上必然放弃。
 */
async function skipReason(review: SubmitArgs["review"], dataDir: string): Promise<string | null> {
  if (review === "none") return REVIEW_NONE_REASON;
  const line = await reviewLine(dataDir);
  return line.ok ? null : line.reason;
}

export async function runSubmit(args: SubmitArgs, dataDir: string, deps: SubmitDeps = {}): Promise<SubmitResult> {
  const loaded = await loadForSubmit(args, dataDir, deps);
  if ("ok" in loaded) return loaded;
  if ("replay" in loaded) return loaded.replay as SubmitResult;
  const { pack } = loaded;
  let content = loaded.content;

  // 长度门在这里（§5.1）：形状不对/正文超 12000 字是**拒收**，不是「写得不好」，不扣修复轮
  const validated = validateSubmitArgs({ title: args.title, hook: args.hook, body: args.body, cta: args.cta, hashtags: args.hashtags });
  if (!validated.ok) return fail(validated.error);
  const payload = validated.payload;
  // 形状合格才开修订周期：被长度门拒收的稿不该白白耗掉一个周期、也不该把稿件推离草稿就绪
  if (loaded.opensCycle) {
    const opened = await openRevisionCycle(content, pack, args, dataDir);
    if (!opened.ok) return opened;
    content = opened.content;
  }

  // 三道门：与内部写手**同一份代码、同一本账、同一组开关**（G4）
  const ledger = restoreEvidenceLedger(pack.ledger, pack.ledgerBudget);
  const { failures, needsHumanNumbers } = runAllGates(payload, packGate(pack), submitDepsFor(ledger));
  const gates: GateOutcome = { payload, failures, needsHuman: needsHumanNumbers, ledger };
  const hard = failures.filter((f) => HARD_GATE_CHECKS.has(f.check));
  if (failures.length > 0 && pack.repair.used < pack.repair.max) return recordRepair(args, pack, failures, dataDir);
  if (hard.length > 0) {
    return record(args, pack, { ...await finalizeBlocked(args, content, pack, gates, hard, dataDir), ...writerProgress(pack, args.host) }, dataDir);
  }
  return acceptForReview(args, content, pack, gates, dataDir, deps);
}

function recordRepair(args: SubmitArgs, pack: ReadyPack, failures: GateFailure[], dataDir: string) {
  pack.repair.used += 1;
  return record(args, pack, {
    status: "repair",
    saved: false,
    quality_status: "needs_revision",
    needs_attention: true,
    ...writerProgress(pack, args.host),
    failures: failures.map((f) => ({ check: f.check, detail: f.detail })),
    rounds_left: pack.repair.max - pack.repair.used,
    next_action: {
      action: "repair_and_resubmit",
      tool: "autocrew_writer",
      params: { action: "submit", content_id: args.contentId, pack_id: args.packId, attempt: args.attempt + 1 },
      message: "按 failures 修复后重交，本次正文尚未保存为新版本。",
    },
    human_next_step: "当前由宿主继续修复，不需要你确认未完成的稿件。",
    note: "按 failures 逐条改，不要重写整篇；改完 attempt 加一再交。",
  }, dataDir);
}

/** 全过：组装 + 去 AI 味一次（审稿读的就是终稿形态），落盘 —— 稿子从这一刻起就不只存在于内存里 */
async function acceptForReview(args: SubmitArgs, content: Content, pack: ReadyPack, gates: GateOutcome, dataDir: string, deps: SubmitDeps): Promise<SubmitResult> {
  const humanizedText = assembleAndHumanize(gates.payload);
  await persistDraft(args, content, gates.payload, humanizedText, {
    ledger: gates.ledger,
    needsHuman: gates.needsHuman,
    versionNote: `${args.host} 交稿（第 ${args.attempt} 次）`,
    reviewPending: args.review !== "none",
    revision: takeRevisionVersion(pack, args.host, args.attempt),
  }, dataDir);
  const job: ReviewJob = {
    contentId: args.contentId,
    packId: args.packId,
    attempt: args.attempt,
    pending: {
      mode: args.review === "engine" ? "engine" : "host",
      host: args.host,
      payload: gates.payload,
      humanizedText,
      needsHuman: gates.needsHuman,
      gateNotes: gates.failures.map((f) => f.detail),
    },
  };
  if ((args.review ?? "host") === "host") return awaitHostReview(args, pack, job, dataDir);
  const skip = await skipReason(args.review, dataDir);
  if (skip) return record(args, pack, await settleReview(job, pack, { kind: "skipped", reason: skip }, dataDir), dataDir);
  return startEngineReview(args, pack, job, dataDir, deps);
}

/**
 * 宿主审稿（P6 §3.7）：签发审稿单并落盘，再在**同一把写手队列里**取审稿包（冻结并保存受众依据）一并还回——
 * 产物与 `review_desk pack` 逐字相同，下一步直接 `review_desk submit`。
 */
async function awaitHostReview(args: SubmitArgs, pack: ReadyPack, job: ReviewJob, dataDir: string): Promise<SubmitResult> {
  const reviewPackId = randomUUID();
  const draftHash = draftHashOf(job.pending.payload.title, job.pending.humanizedText, pack.context.platform);
  const result = {
    status: "awaiting_host_review" as const,
    saved: true,
    quality_status: "awaiting_host_review",
    needs_attention: true,
    content_id: args.contentId,
    attempt: args.attempt,
    review_pack_id: reviewPackId,
    draft_hash: draftHash,
    ...writerProgress(pack, args.host),
    next_action: { tool: "autocrew_review_desk", params: { action: "submit", content_id: args.contentId, review_pack_id: reviewPackId, attempt: args.attempt }, message: "按 review_pack 里的审稿任务读稿，逐条定位问题后提交 issues（无问题传 []）与可选 audience；等待或轮询不会启动后台模型" },
    human_next_step: "宿主正在接手审稿，当前只有保存结果，尚未形成质量结论或创作者采纳。",
    note: "正文已保存，等待宿主审稿；未调用后台模型。审稿材料随本回执给出（review_pack）；丢了用 autocrew_review_desk pack{content_id} 重取，同稿同 attempt 还是同一个 review_pack_id。宿主自审会明确标为自审，不能冒充独立评审。",
  };
  const at = new Date().toISOString();
  pack.attempts[String(args.attempt)] = { status: result.status, at, startedAt: at, pending: job.pending, result, hostReview: { reviewPackId, draftHash, issuedAt: at } };
  notePayload(pack, args);
  await writePack(args.contentId, pack, dataDir);
  const reviewPack = await hostReviewPack(args.contentId, pack, args.host, dataDir);
  if (reviewPack.ok !== false) return { ...result, review_pack: reviewPack };
  return {
    ...result,
    review_pack: reviewPack,
    next_action: { tool: "autocrew_review_desk", params: { action: "pack", content_id: args.contentId }, message: "审稿材料没能随交稿给出（原因见 review_pack.error），用 review_desk pack 重取后再审" },
  };
}

/** 显式 engine 审稿：先落 `reviewing` 再开工，回执立刻还给宿主，终态由 `submit_status` 取 */
async function startEngineReview(args: SubmitArgs, pack: ReadyPack, job: ReviewJob, dataDir: string, deps: SubmitDeps): Promise<SubmitResult> {
  const result = {
    status: "reviewing" as const,
    saved: true,
    quality_status: "reviewing",
    needs_attention: true,
    attempt: args.attempt,
    content_id: args.contentId,
    ...writerProgress(pack, args.host),
    next_action: {
      action: "wait_for_review",
      tool: "autocrew_writer",
      params: { action: "submit_status", content_id: args.contentId, attempt: args.attempt },
      message: "等待审稿终态，再向创作者呈现真实结果和待处理事项。",
    },
    human_next_step: "正文已保存，宿主会继续等待审稿结果；现在尚无需确认成稿。",
    note: REVIEWING_NOTE,
  };
  await record(args, pack, result, dataDir, job.pending);
  startReview(job, dataDir, deps);
  return result;
}
