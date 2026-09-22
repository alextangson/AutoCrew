/**
 * 交稿之后那一遍审稿（P3 spec §5.3，2026-09-06 实机验收后改成异步）——`submit` 的后半段与 `submit_status`。
 *
 * 为什么不能同步审：门禁全过之后的「只审不修」一遍，实机上 DeepSeek 跑了 **161 秒**，
 * 而 MCP 宿主把工具调用卡在 60 秒。同步返回的结果是宿主必然放弃，而服务端照审不误——
 * 宿主看不到结论，稿子却在背后被推成了 `draft_ready`。所以这一段与发包同一个切法：
 *
 *   `submit` 门禁全过 → 落稿 → 记 `attempts[n]={status:"reviewing"}` → 立刻回 `{status:"reviewing"}`
 *   后台只审不修 → 按结论推稿件状态 + 改写 `attempts[n]` 成终态
 *   `submit_status` 轮询到终态
 *
 * 三条纪律（与 `writer-prepare.ts` 同源）：
 * - **同一篇稿同时只有一遍审**：模块级 `reviewing` 表按 content_id 挡重入；
 * - **写回前认号**：`packId` 被 `force` 换掉、或这个 attempt 已经被别人结掉，结果一律丢弃；
 * - **不留悬空的中间态**：进程重启后盘上那个 `reviewing` 由下一次 `submit_status` / `submit` 重跑
 *   （稿早就落盘了，重跑只是再审一次），而不是让创始人对着一张永远「审稿中」的卡等。
 */
import { loadProfile } from "../modules/profile/creator-profile.js";
import { reviewAudienceStay, type AudienceReviewResult } from "../modules/review/audience-review.js";
import { loadEngineConfig, type EngineConfig } from "../engine/config.js";
import { cleanErrorMessage } from "../desktop/error-clean.js";
import type { runLoop } from "../engine/loop.js";
import { reviewOnce, type ReviewInput, type ReviewIssue, type ReviewMeta } from "../modules/writing/script-review.js";
import { buildWritingContract } from "../modules/writing/script-prompt.js";
import { scanText } from "../modules/filter/sensitive-words.js";
import { getContent, transitionStatus, updateContent } from "../storage/local-store.js";
import {
  isReadyPack,
  packGate,
  readPack,
  serializeWriterCall,
  submissionVisibility,
  writerProgress,
  writePack,
  type PendingReview,
  type ReadyPack,
  type SubmitStatus,
} from "./writer-pack.js";
import { describeWriterFailure } from "./writer-failure.js";

export type AudienceAssessment =
  | { status: "reviewed"; result: AudienceReviewResult }
  | { status: "unavailable" | "skipped"; reason: string };

export interface ReviewRunDeps {
  audienceReviewImpl?: typeof reviewAudienceStay;
  runLoopImpl?: typeof runLoop;
  onWarn?: (message: string) => void;
}

/** 一遍审稿要的全部东西：号（fencing）、第几次交、以及那一稿的正文与软门留言 */
export interface ReviewJob {
  contentId: string;
  packId: string;
  attempt: number;
  pending: PendingReview;
}

export type Settled = { status: SubmitStatus } & Record<string, unknown>;

/** 自动修订最多两轮；达到上限只结束自动循环，不把残留问题判为通过。 */
const MAX_REVIEW_ROUNDS = 2;

export const REVIEW_NONE_REASON = "宿主明说这一稿不走产品审稿（review=none）";
export const REVIEWING_NOTE =
  "正文已保存，审稿在后台跑（通常 1–3 分钟），尚无质量结论。用 submit_status{content_id} 轮询到终态，再说明审稿结果和待处理事项；别重交同一稿。";

// ─── 在跑的审稿 ───────────────────────────────────────────────────────────────

/** key 是 content_id，值是**不会 reject** 的后台任务；它同时是「别起第二遍」的锁与测试的等待点 */
const inFlight = new Map<string, Promise<void>>();

/** 测试与桌面端等一遍审稿落地用（生产链路一律轮询 `submit_status`，不 await 它） */
export function reviewInFlight(contentId: string): Promise<void> | undefined {
  return inFlight.get(contentId);
}

/** 只给测试：忘掉在跑的审稿 = 模拟进程重启（盘上仍是 `reviewing`，等着被重跑） */
export function forgetReview(contentId: string): void {
  inFlight.delete(contentId);
}

export function startReview(job: ReviewJob, dataDir: string, deps: ReviewRunDeps): void {
  if (inFlight.has(job.contentId)) return;
  const work = runJob(job, dataDir, deps);
  const task: Promise<void> = work.finally(() => {
    if (inFlight.get(job.contentId) === task) inFlight.delete(job.contentId);
  });
  inFlight.set(job.contentId, task);
}

/**
 * 盘上写着 `reviewing` 但没有任务在跑（进程重启留下的）→ 重跑这一遍。
 * `pending` 万一没留住就按落盘的成稿现搭一份：稿在盘上，缺的只是审稿的入参。
 */
export async function resumeReview(
  contentId: string,
  pack: ReadyPack,
  dataDir: string,
  deps: ReviewRunDeps,
): Promise<void> {
  if (inFlight.has(contentId)) return;
  const hit = Object.entries(pack.attempts).find(([, rec]) => rec.status === "reviewing");
  if (!hit) return;
  const pending = hit[1].pending ?? (await pendingFromDraft(contentId, pack, dataDir));
  if (!pending) return;
  startReview({ contentId, packId: pack.packId, attempt: Number(hit[0]), pending }, dataDir, deps);
}

async function pendingFromDraft(contentId: string, pack: ReadyPack, dataDir: string): Promise<PendingReview | null> {
  const content = await getContent(contentId, dataDir);
  if (!content?.body) return null;
  return {
    host: pack.host,
    payload: { title: content.title, hook: "", body: content.body, cta: "", hashtags: content.hashtags ?? [] },
    humanizedText: content.body,
    needsHuman: content.unverifiedNumbers ?? [],
    gateNotes: [],
  };
}

// ─── 后台这一遍 ───────────────────────────────────────────────────────────────

type ReviewTurn =
  | { kind: "stale" }
  | { kind: "skipped"; reason: string; audience?: AudienceAssessment }
  | { kind: "judged"; issues: ReviewIssue[]; blockers: ReviewIssue[]; reviewedAt: string; audience?: AudienceAssessment };

/** 后台任务**永不 reject**：审稿失败也是一个要落盘的终态，不是掉在地上的 rejection */
async function runJob(job: ReviewJob, dataDir: string, deps: ReviewRunDeps): Promise<void> {
  const warn = deps.onWarn ?? ((m: string) => console.warn(`[writer] ${m}`));
  const turn = await reviewTurn(job, dataDir, deps);
  await applyOutcome(job, turn, dataDir).catch((e) => warn(`审稿结论没写回：${cleanErrorMessage(e)}`));
}

async function reviewTurn(job: ReviewJob, dataDir: string, deps: ReviewRunDeps): Promise<ReviewTurn> {
  try {
    const pack = await readPack(job.contentId, dataDir);
    // 号被 force 换掉了：这一遍审的是一份已作废的包，结果丢掉（同备料那条堵口）
    if (!isReadyPack(pack) || pack.packId !== job.packId) return { kind: "stale" };
    const line = await reviewLine(dataDir);
    if (!line.ok) return { kind: "skipped", reason: line.reason };
    const [outcome, audience] = await Promise.all([
      reviewOnce(reviewInput(pack, job), line.config, {
        ...(deps.runLoopImpl ? { runLoopImpl: deps.runLoopImpl } : {}),
        ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
      }),
      audienceTurn(pack, job, dataDir, deps),
    ]);
    if (!outcome.ok) {
      return { kind: "skipped", reason: await describeWriterFailure(outcome.error, "reviewer", dataDir, outcome.reason), audience };
    }
    return { kind: "judged", issues: outcome.issues, blockers: outcome.blockers, reviewedAt: outcome.reviewedAt, audience };
  } catch (err) {
    return { kind: "skipped", reason: await describeWriterFailure(err, "reviewer", dataDir, cleanErrorMessage(err)) };
  }
}

async function audienceTurn(pack: ReadyPack, job: ReviewJob, dataDir: string, deps: ReviewRunDeps): Promise<AudienceAssessment> {
  try {
    const profile = await loadProfile(dataDir);
    if (!profile?.audiencePersona?.calibratedAt) return { status: "unavailable", reason: "尚无用户确认的受众画像，未进行受众点评；不把猜测的受众作为标准" };
    const result = await (deps.audienceReviewImpl ?? reviewAudienceStay)({
      title: job.pending.payload.title, body: job.pending.humanizedText,
      platform: pack.context.platform, writingContract: packWritingContract(pack),
    }, dataDir, { ...(deps.runLoopImpl ? { runLoopImpl: deps.runLoopImpl } : {}) });
    return { status: "reviewed", result };
  } catch (err) {
    return { status: "unavailable", reason: cleanErrorMessage(err) };
  }
}

/** 审稿线在不在（同步可判的那一半：配置读得出来吗）——`submit` 用它决定这一稿要不要走后台 */
export async function reviewLine(
  dataDir: string,
): Promise<{ ok: true; config: EngineConfig } | { ok: false; reason: string }> {
  try {
    return { ok: true, config: await loadEngineConfig(dataDir) };
  } catch (err) {
    return { ok: false, reason: await describeWriterFailure(err, "reviewer", dataDir, cleanErrorMessage(err)) };
  }
}

function packWritingContract(pack: ReadyPack): string {
  const ctx = pack.context;
  return ctx.writingContract || buildWritingContract(null, ctx.req,
    ctx.angleCard ? { card: ctx.angleCard, evidence: [], tensions: [] } : undefined);
}

function reviewInput(pack: ReadyPack, job: ReviewJob): ReviewInput {
  const ctx = pack.context;
  const gate = packGate(pack);
  return {
    payload: job.pending.payload,
    humanizedText: job.pending.humanizedText,
    system: ctx.prompts.system,
    user: ctx.prompts.user,
    writingContract: packWritingContract(pack),
    ...(ctx.researchSlot ? { researchSlot: ctx.researchSlot } : {}),
    ...(ctx.angleCard ? { angle: ctx.angleCard } : {}),
    voiceSamples: ctx.voiceSamples ?? [],
    ...(gate ? { gate } : {}),
    platform: ctx.platform,
    canFindEvidence: ctx.canFindEvidence,
    needsHumanNumbers: job.pending.needsHuman,
  };
}

/** 认号 + 结论落盘是一个不可分的动作，所以整段进队列（同备料那条队） */
async function applyOutcome(job: ReviewJob, turn: ReviewTurn, dataDir: string): Promise<void> {
  if (turn.kind === "stale") return;
  await serializeWriterCall(job.contentId, async () => {
    const pack = await readPack(job.contentId, dataDir);
    if (!isReadyPack(pack) || pack.packId !== job.packId) return;
    const rec = pack.attempts[String(job.attempt)];
    // 这一次已经被结掉了（重启后重跑的另一条、或人为改盘）：不许把终态再翻一遍
    if (!rec || rec.status !== "reviewing") return;
    const current = await getContent(job.contentId, dataDir);
    const changed = !current || current.platform !== pack.context.platform || current.title !== job.pending.payload.title || current.body !== job.pending.humanizedText;
    const result: Settled = changed
      ? { status: "accepted_unreviewed", saved: true, content_id: job.contentId, quality_status: "stale_review", needs_attention: true, note: "审稿期间正文已变化，本次结论不适用于当前稿；未覆盖新正文或推进状态" }
      : await settleReview(job, pack, turn, dataDir);
    pack.attempts[String(job.attempt)] = {
      status: result.status,
      at: new Date().toISOString(),
      startedAt: rec.startedAt ?? rec.at,
      result,
    };
    await writePack(job.contentId, pack, dataDir);
  });
}

// ─── 结论 → 终态 ─────────────────────────────────────────────────────────────

/**
 * 审稿结论落成六个终态之一（同步的 `review=none` / 审稿线不在也走这里，判据只有一份）：
 *   审稿线没配/坏了 → accepted_unreviewed；无 blocker → accepted；
 *   有 blocker 且轮数 < 2 → review_required（稿件退 revision）；轮数 = 2 → accepted_with_issues。
 */
export async function settleReview(
  job: ReviewJob,
  pack: ReadyPack,
  turn: Exclude<ReviewTurn, { kind: "stale" }>,
  dataDir: string,
): Promise<Settled> {
  const audience = turn.audience ?? { status: "skipped" as const, reason: turn.kind === "skipped" ? turn.reason : "此记录未包含受众点评" };
  const soft = job.pending.gateNotes;
  if (turn.kind === "skipped") {
    await updateContent(job.contentId, { lastError: turn.reason }, dataDir);
    return acceptDraft(job, pack, meta("skipped", pack, []), "accepted_unreviewed", {
      review_skipped_reason: turn.reason,
      audience_review: audience,
      ...(soft.length ? { gate_notes: soft } : {}),
      next_action: {
        action: "disclose_review_gap",
        message: "展示正文并说明未完成审稿的原因和材料缺口；需要继续校验时进行宿主侧审阅或恢复审稿线路，不得将保存成功称为审稿通过。",
      },
      human_next_step: "这一稿尚未经过产品审稿，请在了解缺口后审阅正文；当前没有记录你的认可。",
      note: "正文已保存，但未完成 AI 审稿，质量状态为待审；原因见 review_skipped_reason。",
    }, dataDir);
  }
  if (turn.blockers.length === 0) {
    return acceptDraft(job, pack, meta("passed", pack, turn.issues, turn.reviewedAt), "accepted", {
      audience_review: audience,
      ...(soft.length ? { gate_notes: soft } : {}),
      next_action: {
        action: "present_draft",
        message: "向创作者展示正文、实际调研与立意状态，以及 review.issues / audience_review / gate_notes / unverified_numbers / violations 中的待核对事项。",
      },
      human_next_step: "请审阅正文是否符合你的意图；AI 审稿未发现阻断项，不等于你已认可或批准发布。",
      note: "正文已保存，AI 审稿未发现阻断项；仍需呈现建议和待核对事项，等待创作者实际反馈。",
    }, dataDir);
  }
  if (pack.reviewRounds < MAX_REVIEW_ROUNDS) return { ...(await requireRevision(job, pack, turn, dataDir)), audience_review: audience };
  return acceptDraft(job, pack, meta("failed", pack, turn.issues, turn.reviewedAt), "accepted_with_issues", {
    audience_review: audience,
    issues: turn.blockers,
    ...(soft.length ? { gate_notes: soft } : {}),
    next_action: {
      action: "resolve_review_issues",
      message: "逐条呈现未解决的问题和建议修改，结束自动修订循环；保留现有草稿，不得宣布合格或自动进入发布。",
    },
    human_next_step: "请查看残留问题并决定修改方向；这份草稿仍有阻断问题，尚未获得你的认可。",
    note: `正文已保存；自动修订已到 ${MAX_REVIEW_ROUNDS} 轮上限，仍有 ${turn.blockers.length} 项阻断问题，质量未通过。`,
  }, dataDir);
}

/** 点名退改：稿件退 `revision`，等宿主改完再交下一个 attempt */
async function requireRevision(
  job: ReviewJob,
  pack: ReadyPack,
  turn: { issues: ReviewIssue[]; blockers: ReviewIssue[]; reviewedAt: string },
  dataDir: string,
): Promise<Settled> {
  pack.reviewRounds += 1;
  pack.reviewFixed = (pack.reviewFixed ?? 0) + turn.blockers.length;
  await updateContent(job.contentId, { review: meta("failed", pack, turn.issues, turn.reviewedAt) }, dataDir);
  const moved = await transitionStatus(job.contentId, "revision", {}, dataDir);
  return {
    status: "review_required",
    saved: true,
    quality_status: "needs_revision",
    needs_attention: true,
    content_id: job.contentId,
    ...writerProgress(pack, job.pending.host),
    round: pack.reviewRounds,
    issues: turn.blockers,
    advisories: turn.issues.filter((i) => i.severity !== "blocker"),
    next_action: {
      action: "revise_and_resubmit",
      tool: "autocrew_writer",
      params: { action: "submit", content_id: job.contentId, pack_id: job.packId, attempt: job.attempt + 1 },
      message: "按 issues 修订对应内容后再提交。规划缺项或结构问题可调整相关段落，保留无关内容。",
    },
    human_next_step: "当前由宿主继续修订，尚未进入请你确认成稿的阶段。",
    note: "正文已保存，审稿发现需修订的问题。按问题范围修改并保留无关内容；改完 attempt 加一再交。",
    ...(moved.ok ? { content_status: "revision" } : { warning: `稿件状态推不动：${moved.error ?? "未推进"}` }),
  };
}

function meta(status: ReviewMeta["status"], pack: ReadyPack, issues: ReviewIssue[], at?: string): ReviewMeta {
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
  job: ReviewJob,
  pack: ReadyPack,
  review: ReviewMeta,
  status: SubmitStatus,
  extra: Record<string, unknown>,
  dataDir: string,
): Promise<Settled> {
  const { payload, humanizedText } = job.pending;
  const scan = await scanText(`${payload.title}\n\n${humanizedText}`, pack.context.platform, dataDir);
  await updateContent(
    job.contentId,
    {
      draftReadyAt: new Date().toISOString(),
      // 转正即清：成稿没有「中断」可重试，留一份过期的请求只是 meta 里一处会骗人的旧事实
      genRequest: undefined,
      writingContract: packWritingContract(pack),
      blockedReason: null,
      review,
      _versionNote: versionNote(pack, review),
    },
    dataDir,
  );
  const promoted = await transitionStatus(job.contentId, "draft_ready", {}, dataDir);
  const audience = extra.audience_review as AudienceAssessment | undefined;
  const audienceNeedsAttention = !audience || audience.status !== "reviewed" || !audience.result.coreStops || audience.result.suggestions.length > 0;
  const hasNotes = audienceNeedsAttention || review.issues.length > 0 || job.pending.gateNotes.length > 0 || job.pending.needsHuman.length > 0 || scan.hits.length > 0;
  const qualityStatus = review.status === "skipped"
    ? "unreviewed"
    : review.status === "failed" ? "issues_remaining" : hasNotes ? "passed_with_notes" : "passed";
  return {
    status,
    saved: true,
    quality_status: qualityStatus,
    needs_attention: qualityStatus !== "passed",
    content_id: job.contentId,
    title: payload.title,
    ...writerProgress(pack, job.pending.host),
    review: { status: review.status, rounds: review.rounds, issues: review.issues },
    unverified_numbers: job.pending.needsHuman,
    violations: scan.hits.map((h) => h.word),
    ...extra,
    ...(promoted.ok
      ? { content_status: "draft_ready" }
      : { warning: `稿件状态推不动：${promoted.error ?? "未推进"}（正文已保存）` }),
  };
}

/** 版本注记：这稿有没有材料垫底、有没有经过角度点选、审稿有没有点过名，一句话说清 */
function versionNote(pack: ReadyPack, review: ReviewMeta): string {
  const marks = [
    ...(pack.context.wroteWithoutBrief ? ["未带调研简报"] : []),
    ...(pack.context.wroteWithoutAngle ? ["未经角度点选"] : []),
    ...(pack.context.evidenceNote ? [pack.context.evidenceNote] : []),
  ];
  const judged =
    review.status === "skipped" ? "未经AI审稿" : review.status === "failed" ? `审稿残留 ${review.issues.length} 项` : "AI审稿未发现阻断项";
  return `${pack.host} 写（${[judged, ...marks].join("，")}）`;
}

// ─── submit_status ────────────────────────────────────────────────────────────

export type SubmitStatusResult =
  | ({ ok: true; status: string; attempt: number; elapsed_s: number } & Record<string, unknown>)
  | { ok: false; error: string };

function elapsedSeconds(iso: string): number {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

/**
 * 轮询口。终态回的就是 `submit` 同步时代那份回执（宿主不必换一套读法）；
 * 撞上「盘上 reviewing、进程里没人在跑」就顺手把这一遍重跑起来——查一次状态的副作用只能是**推进**，
 * 不能是把稿永远留在中间态。
 */
export async function submitStatus(
  contentId: string,
  attempt: number | undefined,
  dataDir: string,
  deps: ReviewRunDeps,
): Promise<SubmitStatusResult> {
  const pack = await readPack(contentId, dataDir);
  if (!pack) return { ok: false, error: `这篇没有写作包（${contentId}）——先 pack 一次` };
  const recorded = Object.keys(pack.attempts).map(Number).filter(Number.isInteger);
  if (recorded.length === 0) return { ok: false, error: `这篇还没有收到过提交（${contentId}）——写完先 submit` };
  const want = attempt ?? Math.max(...recorded);
  const rec = pack.attempts[String(want)];
  if (!rec) {
    return { ok: false, error: `没有 attempt ${want} 的提交记录——已记录的是 ${recorded.sort((a, b) => a - b).join(" / ")}` };
  }
  if (rec.status === "reviewing" && isReadyPack(pack)) await resumeReview(contentId, pack, dataDir, deps);
  const result = isReadyPack(pack) ? submissionVisibility(pack, rec.result) : rec.result;
  const { status: _drop, ...rest } = result as { status?: unknown } & Record<string, unknown>;
  return {
    ok: true,
    status: rec.status,
    attempt: want,
    elapsed_s: elapsedSeconds(rec.startedAt ?? rec.at),
    ...rest,
  };
}
