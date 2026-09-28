import { seriesTransaction } from "../storage/series-transaction.js";
import {
  SERIES_REVIEW_RULES, loadSeriesSnapshot, mergeSnapshot, renderSnapshot, seriesReviewSchema, snapshotAdditions, validateSeriesReview,
  type SeriesReview, type SeriesSnapshot,
} from "../modules/writing/series-memory.js";
import { reviewContextHash, updateContentIfDraftMatches } from "../storage/local-store.js";
import { withTokenInNextAction } from "./claim-grant.js";
/** 宿主审稿台：只发材料和收结构化结论，永远不运行后台模型。 */
import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getContent, getDataDir } from "../storage/local-store.js";
import { canonicalJson } from "../modules/research/brief-snapshot.js";
import { loadProfile, personaSummary } from "../modules/profile/creator-profile.js";
import { buildReviewSystemPrompt, buildReviewUserMessage } from "../modules/writing/script-review-prompt.js";
import { validateReview, type HostReviewSource } from "../modules/writing/script-review.js";
import type { AudienceReviewResult } from "../modules/review/audience-review.js";
import { cleanErrorMessage } from "../desktop/error-clean.js";
import { gateClaimWrite } from "../storage/claims.js";
import { DEFAULT_HOST, isReadyPack, readPack, serializeWriterCall, writePack, type PackAttempt, type ReadyPack } from "./writer-pack.js";
import { packWritingContract, reviewInput, settleReview, type AudienceAssessment, type ReviewJob } from "./writer-review.js";
import { storageFailure } from "../storage/storage-error.js";

const nonempty = Type.String({ minLength: 1, maxLength: 12000 });
const issue = Type.Object({
  id: Type.Optional(Type.String({ maxLength: 100 })),
  severity: Type.Union([Type.Literal("blocker"), Type.Literal("advisory")]),
  quote: Type.String({ minLength: 6, maxLength: 60, description: "从标题或当前稿正文逐字复制，不能拼接或改写。" }),
  rule: Type.String({ minLength: 1, maxLength: 200 }),
  instruction: Type.String({ minLength: 1, maxLength: 2000 }),
}, { additionalProperties: false });
const audienceSchema = Type.Object({
  audienceBasis: Type.Object({
    source: Type.Union([Type.Literal("current_task"), Type.Literal("profile")]),
    quote: Type.String({ maxLength: 2000, description: "current_task须逐字引用任务中的受众说明；profile引用审稿包里的已确认画像，可空。" }),
  }, { additionalProperties: false }),
  verdicts: Type.Array(Type.Object({
    tier: Type.Union([Type.Literal("core"), Type.Literal("adjacent"), Type.Literal("surprise")]),
    name: Type.String({ minLength: 1, maxLength: 300 }),
    wouldStop: Type.Boolean(),
    why: Type.String({ minLength: 1, maxLength: 2000 }),
    losesAt: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 3 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
  suggestions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 4 })),
}, { additionalProperties: false });

export const reviewDeskSchema = Type.Object({
  action: Type.Union([Type.Literal("pack"), Type.Literal("submit")]),
  content_id: nonempty,
  review_pack_id: Type.Optional(nonempty),
  attempt: Type.Optional(Type.Integer({ minimum: 1, description: "必须使用审稿包里的原写稿attempt，不是审稿重试次数。" })),
  issues: Type.Optional(Type.Array(issue, { maxItems: 40 })),
  audience: Type.Optional(audienceSchema),
  series_review: Type.Optional(seriesReviewSchema),
  claim_token: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "submit：这篇有活认领时必须带（writer pack/submit 或 autocrew_desk claim 回的令牌），同宿主的另一个会话也一样；pack 只读不用带。" })),
}, { additionalProperties: false });

export const REVIEW_DESK_DESCRIPTION = "Host-executed review, no backend LLM call. writer submit (review=host) already returns this task as review_pack with next_action=review_desk submit; pack{content_id} re-fetches it (same review_pack_id for the same draft and attempt): the saved draft, shared review criteria/creative task, review_pack_id and attempt. The current host reviews it and submits{content_id,review_pack_id,attempt,issues,audience?,series_review?,claim_token?}; when the review pack carries series_snapshot (new writing packs), series_review{snapshot_id,checked,insufficient,findings} is required even if issues is [], and a series_snapshot_stale reply means re-review the added drafts and resubmit with the new snapshot_id; submit is a write, so a claimed draft needs the matching claim_token (same host included) or it returns claim_held. Issues require exact 6-60 character quotes plus rule/severity/instruction. Same authenticated host as the writer is host_self_review; another credential principal is not proof of another model or independent review. Retries with identical payload are idempotent; edited drafts and superseded writing packs are fenced. Review is not user adoption or permission to publish.";

function hashDraft(title: string, body: string, platform?: string): string {
  return createHash("sha256").update(JSON.stringify([title, body, platform])).digest("hex");
}
function sourceOf(reviewerHost: string, writerHost: string, draftHash: string): HostReviewSource {
  return { kind: reviewerHost === writerHost ? "host_self_review" : "host_other_principal_review", reviewerHost, writerHost, independent: false, draftHash };
}
function fail(error: string, status?: string): Record<string, unknown> { return { ok: false, ...(status ? { status } : {}), error }; }
function stale(): Record<string, unknown> {
  return fail("稿件或写作包已经变化，本审稿包不适用于当前稿；重新领取当前稿的写作包并提交后再审阅", "stale_review");
}
function latestAttempt(pack: ReadyPack): [number, PackAttempt] | undefined {
  const ids = Object.keys(pack.attempts).map(Number).filter(Number.isInteger).sort((a, b) => b - a);
  const latest = ids[0];
  return latest === undefined ? undefined : [latest, pack.attempts[String(latest)]];
}

async function freezeAudience(pack: ReadyPack, rec: PackAttempt, dataDir: string): Promise<void> {
  if (!rec.hostReview || rec.hostReview.audienceContext) return;
  const profile = await loadProfile(dataDir);
  const confirmed = Boolean(profile?.audiencePersona?.calibratedAt);
  const persona = confirmed ? profile?.audiencePersona : null;
  rec.hostReview.audienceContext = {
    confirmedProfile: confirmed,
    profileSummary: confirmed ? personaSummary(persona, { allTiers: true }) : "",
    profileTiers: persona ? [
      { tier: "core", name: persona.core.name },
      ...(persona.adjacent ? [{ tier: "adjacent", name: persona.adjacent.name }] : []),
      ...(persona.surprise ? [{ tier: "surprise", name: persona.surprise.name }] : []),
    ] : [],
    writingContract: packWritingContract(pack),
  };
}

/**
 * 审稿包本体（P6 §3.7）：冻结并保存受众依据、签好的 `review_pack_id` 绑定原写稿 attempt 与 draft_hash、组装审稿提示词。
 * `review_desk pack` 与 `writer submit{review:"host"}` 共用这一份，产物逐字相同；同稿同 attempt 重取还是同一个 id。
 * **调用方必须已在本稿的写手队列里**（`serializeWriterCall`）：这里不取锁，嵌套取同一把就是自己等自己。
 */
export async function hostReviewPack(contentId: string, pack: ReadyPack, reviewerHost: string, dataDir: string): Promise<Record<string, unknown>> {
  const latest = latestAttempt(pack);
  if (!latest) return fail("先用autocrew_writer submit保存稿件，才能领取审稿包");
  const [attempt, rec] = latest;
  if (rec.status !== "awaiting_host_review" || !rec.pending || !rec.hostReview) {
    return fail(rec.status === "reviewing" ? "本次是显式engine审稿，请用writer submit_status查看" : "当前没有等待宿主审稿的提交；改稿后重新submit会产生新审稿包");
  }
  const current = await getContent(contentId, dataDir);
  if (!current || current.pack?.packId !== pack.packId || hashDraft(current.title, current.body, current.platform) !== rec.hostReview.draftHash) return stale();
  if (pack.series && !rec.hostReview.seriesSnapshot && rec.pending.payload.outline) rec.hostReview.seriesSnapshot = structuredClone(pack.series);
  await freezeAudience(pack, rec, dataDir);
  await writePack(contentId, pack, dataDir);
  const input = reviewInput(pack, { contentId, packId: pack.packId, attempt, pending: rec.pending });
  const basis = rec.hostReview.audienceContext!;
  const source = sourceOf(reviewerHost, rec.pending.host, rec.hostReview.draftHash);
  return {
    ok: true,
    status: "ready_for_host_review",
    content_id: contentId,
    writing_pack_id: pack.packId,
    review_pack_id: rec.hostReview.reviewPackId,
    draft_hash: rec.hostReview.draftHash,
    attempt,
    review_source: source,
    system: buildReviewSystemPrompt({
      hasResearch: Boolean(input.researchSlot?.trim()), hasWritingContract: Boolean(input.writingContract?.trim()),
      ...(input.angle ? { angle: input.angle } : {}), canFindEvidence: input.canFindEvidence,
      needsHumanNumbers: input.needsHumanNumbers,
    }).replaceAll("submit_review", "autocrew_review_desk submit") + "\n\n本轮由当前宿主执行，不会另起后台模型。若你也是写作者，必须明确这是自审，不能声称独立审阅。提交issues，服务端按blocker计算结论，无需自行填verdict。受众点评是待验证的编辑判断，不是观众实验或爆款预测。",
    user: buildReviewUserMessage(input).replaceAll("submit_review", "autocrew_review_desk submit") + seriesReviewBlock(rec) +
      `\n\n【受众点评依据】\n本次任务明确受众优先：${basis.writingContract || "未提供"}\n已确认账号画像：${basis.profileSummary || "未设置；不要编造画像"}\n` +
      "可以随结论提交audience。采用本次受众时audienceBasis.source=current_task并逐字引用受众要求，只交core；采用已确认画像时source=profile并覆盖实际层次。无法确定受众时省略audience并如实说明未评。wouldStop=false须用losesAt指明原文位置，建议不应违背创作者规划。",
    ...(rec.hostReview.seriesSnapshot ? {
      series_snapshot: rec.hostReview.seriesSnapshot,
      outline: rec.pending.payload.outline ?? null,
      technique_ids: rec.pending.payload.technique_ids ?? [],
      review_context_hash: current.reviewContextHash ?? null,
    } : {}),
    audience_context: basis,
    evidence_ledger: pack.ledger,
    submit_schema: reviewDeskSchema,
    next_action: { tool: "autocrew_review_desk", params: { action: "submit", content_id: contentId, review_pack_id: rec.hostReview.reviewPackId, attempt }, message: "读完稿件与共同任务书，逐条定位问题后提交；不要等待服务端调用模型" },
  };
}

/** 新契约包的审稿任务：比对规则 + 冻结快照 + 新稿自报的摘要（旧包返回空串） */
function seriesReviewBlock(rec: PackAttempt): string {
  const snapshot = rec.hostReview?.seriesSnapshot;
  if (!snapshot) return "";
  const outline = rec.pending?.payload.outline;
  return [
    "", "", SERIES_REVIEW_RULES, renderSnapshot(snapshot),
    outline ? `【新稿作者自报的摘要（只帮你定位，按正文判断）】\n${JSON.stringify(outline)}` : "",
  ].filter((x, i) => i < 2 || x).join("\n");
}

/**
 * 系列比对的结构校验 + 快照过时核对（spec §3 B）。调用方在系列锁里：核对与随后的登记之间不会有别的稿进入范围。
 * 返回 null = 放行；否则是拒收回执（不认领、不落结论）。
 */
async function checkSeriesReview(
  params: Record<string, unknown>, pack: ReadyPack, ticket: NonNullable<PackAttempt["hostReview"]>,
  contentId: string, haystack: string, dataDir: string,
): Promise<Record<string, unknown> | null> {
  const frozen = ticket.seriesSnapshot;
  if (!frozen) return null;
  const problem = validateSeriesReview(params.series_review, frozen, params.issues as Array<{ id?: string; severity?: string }>, haystack);
  if (problem) return fail(problem, "invalid_series_review");
  const live = await loadSeriesSnapshot(pack.context.platform, { contentId, topicId: pack.context.req.topicId }, dataDir);
  const additions = snapshotAdditions(frozen, live);
  if (!additions.length) return null;
  ticket.seriesSnapshot = mergeSnapshot(frozen, additions);
  await writePack(contentId, pack, dataDir);
  return {
    ok: false, status: "series_snapshot_stale",
    error: "审稿期间同平台有新稿进入快照范围（或范围内的稿改了）。补审下面这几条后重交：series_review 换成新的 snapshot_id，checked 覆盖新快照全部条目（已查过的可沿用原结论）。",
    additions: additions.map((i) => i.content_id), series_snapshot: ticket.seriesSnapshot,
    next_action: { tool: "autocrew_review_desk", params: { action: "submit", content_id: contentId, review_pack_id: ticket.reviewPackId, attempt: Number(params.attempt) } },
  };
}

function parseAudience(raw: unknown, rec: PackAttempt, haystack: string): AudienceAssessment | string {
  if (raw === undefined) return { status: "skipped", reason: "宿主未提交受众点评，不能追认为已评；不影响已定位问题的处理" };
  if (!Value.Check(audienceSchema, raw)) return "audience不符合受众点评契约";
  const basis = rec.hostReview?.audienceContext;
  if (!basis) return "先pack领取审稿材料，再提交受众点评";
  const input = raw as { audienceBasis: { source: "profile" | "current_task"; quote: string }; verdicts: AudienceReviewResult["verdicts"]; suggestions?: string[] };
  const current = input.audienceBasis.source === "current_task";
  if (current) {
    if (!input.audienceBasis.quote.trim() || !basis.writingContract.includes(input.audienceBasis.quote)) return "本次受众依据必须逐字引用审稿包里的任务说明";
  } else if (!basis.confirmedProfile || !basis.profileSummary || (input.audienceBasis.quote && !basis.profileSummary.includes(input.audienceBasis.quote))) {
    return "没有可用的已确认画像，或画像引文不匹配；不能虚构profile受众点评";
  }
  const expected = current ? ["core"] : (basis.profileTiers ?? []).map(item => item.tier);
  const verdicts = input.verdicts;
  if (verdicts.length !== expected.length || new Set(verdicts.map(v => v.tier)).size !== verdicts.length || verdicts.some(v =>
    !expected.includes(v.tier) || !v.name.trim() || !v.why.trim() ||
    (!current && basis.profileTiers?.find(item => item.tier === v.tier)?.name !== v.name) ||
    (!v.wouldStop && v.losesAt.length === 0) || v.losesAt.some(quote => !quote.trim() || !haystack.includes(quote))
  )) return "受众层次须与实际依据相符；不愿读完的判断必须用losesAt逐字定位稿件，不能编造原句";
  return { status: "reviewed", result: {
    coreStops: verdicts.find(v => v.tier === "core")!.wouldStop,
    verdicts, suggestions: input.suggestions ?? [], audienceBasis: input.audienceBasis,
    personaUsed: current ? `本次任务指定受众：${input.audienceBasis.quote}` : basis.profileSummary,
  } };
}

/** `grant` 是回执令牌的出参：落盘中途抛错时调用方照样能把刚认领到的令牌交回去 */
async function submitReview(params: Record<string, unknown>, pack: ReadyPack, reviewerHost: string, dataDir: string, grant: { claim_token?: string }): Promise<Record<string, unknown>> {
  const contentId = String(params.content_id);
  const attempt = Number(params.attempt);
  const rec = pack.attempts[String(attempt)];
  const ticket = rec?.hostReview;
  if (!Number.isInteger(attempt) || !ticket || params.review_pack_id !== ticket.reviewPackId) return fail("审稿包编号或attempt不匹配；使用pack返回的参数", "stale_review");
  if (latestAttempt(pack)?.[0] !== attempt) return stale();
  const current = await getContent(contentId, dataDir);
  if (!current || current.pack?.packId !== pack.packId || hashDraft(current.title, current.body, current.platform) !== ticket.draftHash) return stale();
  if (!Array.isArray(params.issues)) return fail("submit必须提供issues数组，无问题时显式传[]");
  // series_review 只在提交了时进指纹：升级前钉住的旧审稿提交重放不会被误判成冲突
  const digest = createHash("sha256").update(canonicalJson({ issues: params.issues, audience: params.audience ?? null, ...(params.series_review !== undefined ? { series_review: params.series_review } : {}), reviewerHost })).digest("hex");
  if (ticket.submission) {
    if (ticket.submission.digest !== digest) return fail("此审稿包已经提交另一份结论，不能覆盖；相同重试须保持相同内容与凭证主体", "review_conflict");
    if (ticket.submission.result) return { ...ticket.submission.result, replayed: true };
  }
  if (rec.status !== "awaiting_host_review" || rec.pending?.mode !== "host") return fail("本次提交没有等待宿主审稿，不能把旧结论套到其他审稿模式");
  if (!ticket.audienceContext) return fail("先pack领取审稿材料，再提交结论");
  const haystack = `${current.title}\n\n${current.body}`;
  const checked = validateReview({ verdict: params.issues.some((item: unknown) => (item as { severity?: unknown })?.severity === "blocker") ? "revise" : "pass", issues: params.issues }, haystack, attempt, true);
  if (!checked.ok) return fail(checked.problems.join("；"), "invalid_review");
  const audience = parseAudience(params.audience, rec, haystack);
  if (typeof audience === "string") return fail(audience, "invalid_review");
  const seriesRejected = await checkSeriesReview(params, pack, ticket, contentId, haystack, dataDir);
  if (seriesRejected) return seriesRejected;
  // 写门（P6 §3.8）：核对全过、真要落盘才过门——被拒的审稿不认领也不续租，重放不写盘也不设卡
  const token = typeof params.claim_token === "string" ? params.claim_token.trim() : "";
  const gate = await gateClaimWrite(contentId, { host: reviewerHost, employee: "writer", token: token || undefined }, dataDir);
  if ("denied" in gate) return gate.denied;
  Object.assign(grant, gate.grant);
  if (ticket.seriesSnapshot) {
    // 系列比对结果随这一版落盘，绑定审稿上下文指纹；状态本身不证明去重通过（spec §3 B「状态不能当证明」）
    // 一次原子写、且只在稿件仍是被审的那一版时落：审稿期间正文被改就不留任何比对结论（Codex 评审 P1）
    const review = params.series_review as SeriesReview;
    const bound = await updateContentIfDraftMatches(contentId, current, (latest) => ({
      seriesSnapshotId: review.snapshot_id,
      seriesReview: { ...review, reviewContextHash: reviewContextHash(latest, { ...latest, seriesSnapshotId: review.snapshot_id }), recordedAt: new Date().toISOString() },
    }), dataDir);
    if (!bound.ok) return stale();
  }
  const source = sourceOf(reviewerHost, rec.pending.host, ticket.draftHash);
  // 先钉住这次提交，再改变内容状态。重启后同一载荷可恢复，不允许另一份结论抢写。
  ticket.submission = { digest, reviewerHost, state: "pending" };
  await writePack(contentId, pack, dataDir);
  const job: ReviewJob = { contentId, packId: pack.packId, attempt, pending: rec.pending };
  const settled = await settleReview(job, pack, {
    kind: "judged", issues: checked.issues, blockers: checked.issues.filter(issue => issue.severity === "blocker"), reviewedAt: new Date().toISOString(), audience, source,
  }, dataDir);
  const result = { ok: true, ...settled, review_source: source, review_pack_id: ticket.reviewPackId, draft_hash: ticket.draftHash, attempt };
  ticket.submission = { digest, reviewerHost, state: "applied", result };
  pack.attempts[String(attempt)] = { status: settled.status, at: new Date().toISOString(), startedAt: rec.startedAt ?? rec.at, result, hostReview: ticket };
  await writePack(contentId, pack, dataDir);
  return result;
}

export async function executeReviewDesk(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dataDir = getDataDir(typeof params._dataDir === "string" ? params._dataDir : undefined);
  const publicArgs = Object.fromEntries(Object.entries(params).filter(([key]) => !key.startsWith("_")));
  if (!Value.Check(reviewDeskSchema, publicArgs)) return fail("审稿台参数不符合工具契约");
  const contentId = String(params.content_id);
  const reviewerHost = typeof params._host === "string" && params._host.trim() ? params._host : DEFAULT_HOST;
  // submit 改审稿结论、推进稿件状态，过令牌门（门在 submitReview 里）；pack 只读不设卡。
  // 令牌只进回执不进写作包：存下来的审稿结果会被重放给别人
  const grant: { claim_token?: string } = {};
  try {
    const result = await serializeWriterCall(contentId, async () => {
      const pack = await readPack(contentId, dataDir);
      if (!isReadyPack(pack)) return fail("稿件没有可用的写作包，先完成writer pack与submit");
      return params.action === "pack" ? hostReviewPack(contentId, pack, reviewerHost, dataDir) : seriesTransaction(() => submitReview(params, pack, reviewerHost, dataDir, grant));
    });
    return withTokenInNextAction({ ...result, ...grant });
  } catch (err) {
    const storage = storageFailure(err);
    if (storage) return { ...storage, ...grant };
    const error = cleanErrorMessage(err);
    return { ...fail(error, error.includes("stale_review") ? "stale_review" : undefined), ...grant };
  }
}
