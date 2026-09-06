/**
 * 宿主交稿（P3 spec §5.3）——把写手循环翻过来的另一半：**收稿**。
 *
 * 一条状态机，全部走同一份门禁代码（`runAllGates` + `submitDepsFor`）：
 *
 *   长度门（在 `validateSubmitArgs` 里）→ 格式门 / 数字门 / 质量门
 *     ├─ 有未过项且修复轮有余额 → repair（稿不落盘，计数 +1）
 *     ├─ 硬门未过且余额用尽     → blocked → 稿件 needs_evidence
 *     └─ 全过 → 人味化 → 落稿 → 只审不修
 *           ├─ review=none / 审稿线没配 → 当场 accepted_unreviewed（这两种是瞬时判断，不必转后台）
 *           └─ 其余 → reviewing（**立刻返回**），审稿在 `writer-review.ts` 的后台跑，
 *               终态由 `submit_status` 取——审一遍实测 161 秒，宿主 60 秒就掐调用。
 *
 * 三条纪律：
 * 1. **`status` 永远是返回体第一个字段**（§8 防呆）：人设要求宿主先看它。
 * 2. **同 `attempt` 重放不产生任何副作用**：原样还回上次结果，不扣修复轮、不推状态。
 * 3. **降级必须可见**：审稿失败不静默跳过，落 `review.status = skipped` + 人话原因 + `lastError`。
 */
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
} from "../storage/local-store.js";
import {
  isReadyPack,
  packGate,
  packNotReadyError,
  readPack,
  stalePackError,
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

export type SubmitResult = ({ status: SubmitPhase } & Record<string, unknown>) | { ok: false; error: string };

export interface SubmitArgs {
  contentId: string;
  packId: string;
  attempt: number;
  title: string;
  hook: string;
  body: string;
  cta: string;
  hashtags: unknown;
  /** 缺省 `engine`：产品内部的 reviewer 岗位审一遍（§9.1 待确认项，默认按此实现） */
  review: "engine" | "none";
  host: string;
}

export type SubmitDeps = ReviewRunDeps;

const WRITABLE: ContentStatus[] = ["drafting", "revision"];

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

// ─── 前置校验 ─────────────────────────────────────────────────────────────────

type Loaded = { content: Content; pack: ReadyPack };

async function loadForSubmit(
  args: SubmitArgs,
  dataDir: string,
  deps: SubmitDeps,
): Promise<Loaded | { ok: false; error: string } | { replay: Record<string, unknown> }> {
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
  const done = pack.attempts[String(args.attempt)];
  // 幂等（§5.2）：网络重发、宿主重试都会撞到这里——原样还回去，不扣修复轮、不推状态
  if (done) return { replay: { ...done.result, replayed: true, replayed_at: done.at } };
  // 状态门放在重放之后：稿子已经 draft_ready 时宿主重发同一 attempt，要拿回「已收下」而不是「不收稿」
  if (!WRITABLE.includes(content.status)) {
    return fail(`这篇现在是「${content.status}」，不收稿——只有写作中 / 修订中的稿能提交（${args.contentId}）`);
  }
  // 上一稿还在审：这时候收下一版就是同一篇稿两遍审稿抢着推状态，先让他等结果
  const pendingAttempt = Object.entries(pack.attempts).find(([, rec]) => rec.status === "reviewing");
  if (pendingAttempt) return fail(`上一稿（attempt ${pendingAttempt[0]}）还在审，先 submit_status 等结果`);
  const highest = Math.max(0, ...Object.keys(pack.attempts).map((k) => Number(k)));
  if (args.attempt < highest) {
    return fail(`过期重试：这篇已经收到过 attempt ${highest}，你交的是 ${args.attempt}——改用 ${highest + 1} 重交`);
  }
  return { content, pack };
}

// ─── 落盘 ─────────────────────────────────────────────────────────────────────

async function record(
  contentId: string,
  pack: WritingPackFile,
  attempt: number,
  result: { status: SubmitPhase } & Record<string, unknown>,
  dataDir: string,
  /** 只有 `reviewing` 带它：后台那一遍的入参，进程重启后靠它重跑 */
  pending?: PendingReview,
): Promise<{ status: SubmitPhase } & Record<string, unknown>> {
  const at = new Date().toISOString();
  pack.attempts[String(attempt)] = { status: result.status, at, startedAt: at, result, ...(pending ? { pending } : {}) };
  await writePack(contentId, pack, dataDir);
  return result;
}

/** 交稿即落盘（不管后面审稿结果如何）：审稿要跑几分钟，这中间稿子不许只存在于内存里 */
async function persistDraft(
  args: SubmitArgs,
  content: Content,
  payload: SubmitPayload,
  humanizedText: string,
  extra: { ledger: EvidenceLedger; needsHuman: string[]; versionNote: string },
  dataDir: string,
): Promise<void> {
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
      pack: { ...content.pack!, submittedAt: new Date().toISOString() },
      _versionNote: extra.versionNote,
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

async function finalizeBlocked(
  args: SubmitArgs,
  content: Content,
  payload: SubmitPayload,
  hard: GateFailure[],
  all: { failures: GateFailure[]; needsHuman: string[]; ledger: EvidenceLedger },
  dataDir: string,
): Promise<{ status: SubmitPhase } & Record<string, unknown>> {
  const humanizedText = assembleAndHumanize(payload);
  const unverified = [...blockedNumbers(all.failures), ...all.needsHuman];
  const reason = hard[0]?.detail ?? "硬门未通过";
  await persistDraft(args, content, payload, humanizedText, {
    ledger: all.ledger,
    needsHuman: unverified,
    versionNote: `${args.host} 交稿被硬门拦下（缺证据，未转草稿）`,
  }, dataDir);
  await updateContent(args.contentId, { blockedReason: reason }, dataDir);
  const moved = await transitionStatus(args.contentId, "needs_evidence", {}, dataDir);
  return {
    status: "blocked",
    reason,
    unverified_numbers: unverified,
    content_status: moved.ok ? "needs_evidence" : content.status,
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
  const { content, pack } = loaded;

  // 长度门在这里（§5.1）：形状不对/正文超 12000 字是**拒收**，不是「写得不好」，不扣修复轮
  const validated = validateSubmitArgs({
    title: args.title,
    hook: args.hook,
    body: args.body,
    cta: args.cta,
    hashtags: args.hashtags,
  });
  if (!validated.ok) return fail(validated.error);
  const payload = validated.payload;

  // 三道门：与内部写手**同一份代码、同一本账、同一组开关**（G4）
  const ledger = restoreEvidenceLedger(pack.ledger, pack.ledgerBudget);
  const { failures, needsHumanNumbers } = runAllGates(payload, packGate(pack), submitDepsFor(ledger));
  const hard = failures.filter((f) => HARD_GATE_CHECKS.has(f.check));

  if (failures.length > 0 && pack.repair.used < pack.repair.max) {
    pack.repair.used += 1;
    return record(args.contentId, pack, args.attempt, {
      status: "repair",
      failures: failures.map((f) => ({ check: f.check, detail: f.detail })),
      rounds_left: pack.repair.max - pack.repair.used,
      note: "按 failures 逐条改，不要重写整篇；改完 attempt 加一再交。",
    }, dataDir);
  }
  if (hard.length > 0) {
    return record(
      args.contentId,
      pack,
      args.attempt,
      await finalizeBlocked(args, content, payload, hard, { failures, needsHuman: needsHumanNumbers, ledger }, dataDir),
      dataDir,
    );
  }

  // 全过：组装 + 去 AI 味一次（审稿读的就是终稿形态），落盘 —— 稿子从这一刻起就不只存在于内存里
  const humanizedText = assembleAndHumanize(payload);
  await persistDraft(args, content, payload, humanizedText, {
    ledger,
    needsHuman: needsHumanNumbers,
    versionNote: `${args.host} 交稿（第 ${args.attempt} 次）`,
  }, dataDir);
  const job: ReviewJob = {
    contentId: args.contentId,
    packId: args.packId,
    attempt: args.attempt,
    pending: {
      host: args.host,
      payload,
      humanizedText,
      needsHuman: needsHumanNumbers,
      gateNotes: failures.map((f) => f.detail),
    },
  };

  const skip = await skipReason(args.review, dataDir);
  if (skip) {
    const settled = await settleReview(job, pack, { kind: "skipped", reason: skip }, dataDir);
    return record(args.contentId, pack, args.attempt, settled, dataDir);
  }
  // 先落 `reviewing` 再开工：回执立刻还给宿主，终态由 `submit_status` 取
  const result = {
    status: "reviewing" as const,
    attempt: args.attempt,
    content_id: args.contentId,
    note: REVIEWING_NOTE,
  };
  await record(args.contentId, pack, args.attempt, result, dataDir, job.pending);
  startReview(job, dataDir, deps);
  return result;
}
