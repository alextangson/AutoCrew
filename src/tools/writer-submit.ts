/**
 * 宿主交稿（P3 spec §5.3）——把写手循环翻过来的另一半：**收稿**。
 *
 * 一条状态机，六个出口，全部走同一份门禁代码（`runAllGates` + `submitDepsFor`）：
 *
 *   长度门（在 `validateSubmitArgs` 里）→ 格式门 / 数字门 / 质量门
 *     ├─ 有未过项且修复轮有余额 → repair（稿不落盘，计数 +1）
 *     ├─ 硬门未过且余额用尽     → blocked → 稿件 needs_evidence
 *     └─ 全过 → 人味化 → 落稿 → 只审不修（reviewOnce）
 *           ├─ 审稿线没配/坏了 → accepted_unreviewed（review.status = skipped，原因走 P2 翻译器）
 *           ├─ 无 blocker      → accepted（draft_ready）
 *           ├─ 有 blocker 且轮数 < 2 → review_required（稿件退 revision，等宿主改）
 *           └─ 有 blocker 且轮数 = 2 → accepted_with_issues（draft_ready，残留留痕）
 *
 * 三条纪律：
 * 1. **`status` 永远是返回体第一个字段**（§8 防呆）：人设要求宿主先看它。
 * 2. **同 `attempt` 重放不产生任何副作用**：原样还回上次结果，不扣修复轮、不推状态。
 * 3. **降级必须可见**：审稿失败不静默跳过，落 `review.status = skipped` + 人话原因 + `lastError`。
 */
import { classifyEngineError } from "../engine/error-kind.js";
import { hostOf, loadEngineConfig, resolveEngineRoute } from "../engine/config.js";
import { describeEngineFailure, isEngineFailure } from "../engine/failure-text.js";
import { cleanErrorMessage } from "../desktop/error-clean.js";
import type { runLoop } from "../engine/loop.js";
import { getPack } from "../modules/packs/index.js";
import { resolveQualityGate } from "../modules/writing/quality-gate.js";
import { HARD_GATE_CHECKS, type GateFailure } from "../modules/writing/quality-gate.js";
import {
  assembleAndHumanize,
  runAllGates,
  validateSubmitArgs,
  type SubmitPayload,
} from "../modules/writing/script-payload.js";
import { submitDepsFor } from "../modules/writing/generate-script.js";
import { restoreEvidenceLedger, type EvidenceLedger } from "../modules/research/evidence-ledger.js";
import { reviewOnce, type ReviewInput, type ReviewIssue, type ReviewMeta } from "../modules/writing/script-review.js";
import { scanText } from "../modules/filter/sensitive-words.js";
import {
  getContent,
  transitionStatus,
  updateContent,
  type Content,
  type ContentStatus,
} from "../storage/local-store.js";
import { readPack, stalePackError, writePack, type SubmitStatus, type WritingPackFile } from "./writer-pack.js";

export type SubmitResult = ({ status: SubmitStatus } & Record<string, unknown>) | { ok: false; error: string };

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

export interface SubmitDeps {
  runLoopImpl?: typeof runLoop;
  onWarn?: (message: string) => void;
}

const WRITABLE: ContentStatus[] = ["drafting", "revision"];
/** 审稿最多点两轮名（§5.3）：第三轮就是无限润色，按残留收下 */
const MAX_REVIEW_ROUNDS = 2;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

// ─── 前置校验 ─────────────────────────────────────────────────────────────────

type Loaded = { content: Content; pack: WritingPackFile };

async function loadForSubmit(
  args: SubmitArgs,
  dataDir: string,
): Promise<Loaded | { ok: false; error: string } | { replay: Record<string, unknown> }> {
  const content = await getContent(args.contentId, dataDir);
  if (!content) return fail(`稿件不存在：${args.contentId}`);
  // packId 是写手侧的 fencing token（§5.2）：再领一次包就把旧号作废，迟到的提交必须被拒
  if (content.pack?.packId !== args.packId) return fail(stalePackError(content.pack?.packId, args.packId));
  if (!WRITABLE.includes(content.status)) {
    return fail(`这篇现在是「${content.status}」，不收稿——只有写作中 / 修订中的稿能提交（${args.contentId}）`);
  }
  const pack = await readPack(args.contentId, dataDir);
  if (!pack || pack.packId !== args.packId) return fail(stalePackError(pack?.packId, args.packId));

  if (!Number.isInteger(args.attempt) || args.attempt < 1) {
    return fail(`attempt 必须是 ≥1 的整数（每提交一次加一），收到的是 ${String(args.attempt)}`);
  }
  const done = pack.attempts[String(args.attempt)];
  // 幂等（§5.2）：网络重发、宿主重试都会撞到这里——原样还回去，不扣修复轮、不推状态
  if (done) return { replay: { ...done.result, replayed: true, replayed_at: done.at } };
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
  result: { status: SubmitStatus } & Record<string, unknown>,
  dataDir: string,
): Promise<{ status: SubmitStatus } & Record<string, unknown>> {
  pack.attempts[String(attempt)] = { status: result.status, at: new Date().toISOString(), result };
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
): Promise<{ status: SubmitStatus } & Record<string, unknown>> {
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

// ─── 审稿（只审不修） ─────────────────────────────────────────────────────────

/** 审稿线炸了的人话（P2 §4.2 翻译器）：只翻译线路故障，其余原样说更诚实 */
async function reviewFailureText(reason: string, err: unknown, dataDir: string): Promise<string> {
  const classified = classifyEngineError(err);
  if (!isEngineFailure(classified)) return reason;
  try {
    const config = await loadEngineConfig(dataDir);
    const route = resolveEngineRoute(config, "reviewer", config.strongModel);
    const id = route.config.activeProvider?.id ?? "main";
    const provider = (config.providers ?? []).find((p) => p.id === id);
    return describeEngineFailure({
      role: "reviewer",
      provider: { id, host: hostOf(provider?.baseUrl ?? route.config.baseUrl) },
      classified,
      fallbackAvailable: Boolean(config.fallback),
    });
  } catch {
    return cleanErrorMessage(err) || reason;
  }
}

type ReviewTurn =
  | { kind: "skipped"; reason: string }
  | { kind: "judged"; issues: ReviewIssue[]; blockers: ReviewIssue[]; reviewedAt: string };

async function runReview(
  args: SubmitArgs,
  pack: WritingPackFile,
  payload: SubmitPayload,
  humanizedText: string,
  needsHuman: string[],
  dataDir: string,
  deps: SubmitDeps,
): Promise<ReviewTurn> {
  if (args.review === "none") return { kind: "skipped", reason: "宿主明说这一稿不走产品审稿（review=none）" };
  const ctx = pack.context;
  let config;
  try {
    config = await loadEngineConfig(dataDir);
  } catch (err) {
    return { kind: "skipped", reason: await reviewFailureText(cleanErrorMessage(err), err, dataDir) };
  }
  const input: ReviewInput = {
    payload,
    humanizedText,
    system: ctx.prompts.system,
    user: ctx.prompts.user,
    ...(ctx.researchSlot ? { researchSlot: ctx.researchSlot } : {}),
    ...(ctx.angleCard ? { angle: ctx.angleCard } : {}),
    voiceSamples: ctx.voiceSamples ?? [],
    ...(resolveGate(pack) ? { gate: resolveGate(pack) } : {}),
    platform: ctx.platform,
    canFindEvidence: ctx.canFindEvidence,
    needsHumanNumbers: needsHuman,
  };
  const outcome = await reviewOnce(input, config, {
    ...(deps.runLoopImpl ? { runLoopImpl: deps.runLoopImpl } : {}),
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
  });
  if (!outcome.ok) return { kind: "skipped", reason: await reviewFailureText(outcome.reason, outcome.error, dataDir) };
  return { kind: "judged", issues: outcome.issues, blockers: outcome.blockers, reviewedAt: outcome.reviewedAt };
}

function resolveGate(pack: WritingPackFile) {
  return resolveQualityGate(getPack(pack.context.trackPackId), pack.context.platform);
}

function meta(status: ReviewMeta["status"], pack: WritingPackFile, issues: ReviewIssue[], at?: string): ReviewMeta {
  return {
    status,
    rounds: pack.reviewRounds,
    fixed: pack.reviewFixed ?? 0,
    issues,
    reviewedAt: at ?? new Date().toISOString(),
  };
}

/** 收下这一稿：违禁词扫描 → 审稿结论落盘 → 转草稿就绪 */
async function acceptDraft(
  args: SubmitArgs,
  pack: WritingPackFile,
  payload: SubmitPayload,
  humanizedText: string,
  review: ReviewMeta,
  status: SubmitStatus,
  extra: Record<string, unknown>,
  dataDir: string,
): Promise<{ status: SubmitStatus } & Record<string, unknown>> {
  const scan = await scanText(`${payload.title}\n\n${humanizedText}`, pack.context.platform, dataDir);
  await updateContent(
    args.contentId,
    {
      draftReadyAt: new Date().toISOString(),
      // 转正即清：成稿没有「中断」可重试，留一份过期的请求只是 meta 里一处会骗人的旧事实
      genRequest: undefined,
      blockedReason: null,
      review,
      _versionNote: versionNote(pack, review),
    },
    dataDir,
  );
  const promoted = await transitionStatus(args.contentId, "draft_ready", {}, dataDir);
  return {
    status,
    content_id: args.contentId,
    title: payload.title,
    review: { status: review.status, rounds: review.rounds, issues: review.issues },
    violations: scan.hits.map((h) => h.word),
    ...extra,
    ...(promoted.ok
      ? { content_status: "draft_ready" }
      : { warning: `稿件状态推不动：${promoted.error ?? "未推进"}（正文已保存）` }),
  };
}

/** 版本注记：这稿有没有材料垫底、有没有经过角度点选、审稿有没有点过名，一句话说清 */
function versionNote(pack: WritingPackFile, review: ReviewMeta): string {
  const marks = [
    ...(pack.context.wroteWithoutBrief ? ["未带调研简报"] : []),
    ...(pack.context.wroteWithoutAngle ? ["未经角度点选"] : []),
    ...(pack.context.evidenceNote ? [pack.context.evidenceNote] : []),
  ];
  const who = `${pack.host} 写`;
  const judged =
    review.status === "skipped" ? "未经AI审稿" : review.status === "failed" ? `审稿残留 ${review.issues.length} 项` : "已过AI审稿";
  return `${who}（${[judged, ...marks].join("，")}）`;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

export async function runSubmit(args: SubmitArgs, dataDir: string, deps: SubmitDeps = {}): Promise<SubmitResult> {
  const loaded = await loadForSubmit(args, dataDir);
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
  const { failures, needsHumanNumbers } = runAllGates(payload, resolveGate(pack), submitDepsFor(ledger));
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

  // 全过：组装 + 去 AI 味一次（审稿读的就是终稿形态），落盘，再只审不修
  const humanizedText = assembleAndHumanize(payload);
  await persistDraft(args, content, payload, humanizedText, {
    ledger,
    needsHuman: needsHumanNumbers,
    versionNote: `${args.host} 交稿（第 ${args.attempt} 次）`,
  }, dataDir);
  const turn = await runReview(args, pack, payload, humanizedText, needsHumanNumbers, dataDir, deps);
  const soft = failures.map((f) => f.detail);

  if (turn.kind === "skipped") {
    const review = meta("skipped", pack, []);
    await updateContent(args.contentId, { lastError: turn.reason }, dataDir);
    return record(
      args.contentId,
      pack,
      args.attempt,
      await acceptDraft(args, pack, payload, humanizedText, review, "accepted_unreviewed", {
        review_skipped_reason: turn.reason,
        ...(soft.length ? { gate_notes: soft } : {}),
        note: "稿子收下了，但这一稿没经过 AI 审稿——原因见 review_skipped_reason。",
      }, dataDir),
      dataDir,
    );
  }

  if (turn.blockers.length === 0) {
    const review = meta("passed", pack, turn.issues, turn.reviewedAt);
    return record(
      args.contentId,
      pack,
      args.attempt,
      await acceptDraft(args, pack, payload, humanizedText, review, "accepted", {
        ...(soft.length ? { gate_notes: soft } : {}),
        note: "审稿没点 blocker，稿子收下了。advisory 在 review.issues 里，改不改由创始人定。",
      }, dataDir),
      dataDir,
    );
  }

  if (pack.reviewRounds < MAX_REVIEW_ROUNDS) {
    pack.reviewRounds += 1;
    pack.reviewFixed = (pack.reviewFixed ?? 0) + turn.blockers.length;
    const review = meta("failed", pack, turn.issues, turn.reviewedAt);
    await updateContent(args.contentId, { review }, dataDir);
    const moved = await transitionStatus(args.contentId, "revision", {}, dataDir);
    return record(args.contentId, pack, args.attempt, {
      status: "review_required",
      round: pack.reviewRounds,
      issues: turn.blockers,
      advisories: turn.issues.filter((i) => i.severity !== "blocker"),
      note: "只改被点名的那几句，别重写整篇；改完 attempt 加一再交。",
      ...(moved.ok ? { content_status: "revision" } : { warning: `稿件状态推不动：${moved.error ?? "未推进"}` }),
    }, dataDir);
  }

  const review = meta("failed", pack, turn.issues, turn.reviewedAt);
  return record(
    args.contentId,
    pack,
    args.attempt,
    await acceptDraft(args, pack, payload, humanizedText, review, "accepted_with_issues", {
      issues: turn.blockers,
      ...(soft.length ? { gate_notes: soft } : {}),
      note: `审稿点了 ${MAX_REVIEW_ROUNDS} 轮仍有 ${turn.blockers.length} 项没解决，按残留收下——创始人过稿时会看到这份清单。`,
    }, dataDir),
    dataDir,
  );
}
