/** Shared, read-only preparation gate for every MCP writing entry. */
import { inheritCreativeTask, createCreativeTask, creativeTaskHash, creativeTaskMatches, type CreativeTask } from "../modules/writing/creative-task.js";
import { activeAngleCard, angleCardHash, angleCardsOf } from "../modules/research/angle-cards.js";
import { resolveEffectiveBrief } from "../modules/research/brief-snapshot.js";
import { getJob, topicHashOf } from "../modules/research/research-job-store.js";
import { getTopic } from "../storage/local-store.js";
import { ANGLE_GATE_COPY, founderChoiceOf, latestDecision, newDraftAngleRefusal, topicHasDraft } from "../modules/research/angle-gate.js";
import { angleOptionsView, jobView } from "./workflow-views.js";

export interface WritingReadinessRequest {
  platform?: string;
  direction?: string;
  requirements?: string;
  angleSkipReason?: string;
  research?: string;
  researchMode?: "auto" | "provided" | "skip";
  researchReason?: string;
}

export interface WritingReadiness {
  ready: boolean;
  status: "not_started" | "researching" | "needs_attention" | "needs_angle" | "ready_to_write";
  topicId: string;
  creativeTask?: CreativeTask;
  research: {
    mode: "auto" | "provided" | "skip";
    status: "not_started" | "running" | "failed" | "stale" | "complete" | "partial" | "provided" | "skipped";
    /** True only when AutoCrew has a current successful/partial brief. */
    autoResearched: boolean;
    executedBy?: { kind: "host"; host: string } | { kind: "engine" };
    matchesRequestedTask?: boolean;
    creativeTaskHash?: string;
    briefRevision?: number;
    briefHash?: string;
    summary?: string;
    gaps?: string[];
    sourceCount?: number;
    stale?: boolean;
    reason?: string;
    job?: Record<string, unknown>;
  };
  angle: {
    status: "selected" | "direction" | "skipped" | "needs_selection" | "missing";
    cards: Record<string, unknown>[];
    recommendation?: { angleId: string; reasons: string[]; automaticSelection: false };
    selectedAngleId?: string;
    selectedAngleHash?: string;
    reason?: string;
  };
  note: string;
  next_action: { tool: string; params: Record<string, unknown> };
  continue_params: Record<string, unknown>;
}

export function writingReadinessFailure(readiness: WritingReadiness): { ok: false; error: string } & Record<string, unknown> {
  const summary = readiness.angle.cards
    .map(card => `${card.id}【${card.angle}】主张：${card.thesis}｜不写：${card.antiScope}`)
    .join("\n");
  return {
    ok: false,
    code: readiness.status === "needs_angle" ? "needs_angle" : "writing_not_prepared",
    error: `${readiness.note}${summary ? `\n${summary}` : ""}`,
    needsAngle: readiness.status === "needs_angle",
    needsResearch: readiness.research.mode === "auto" && !["complete", "partial"].includes(readiness.research.status),
    status: readiness.status,
    briefRevision: readiness.research.briefRevision,
    cards: readiness.angle.cards,
    preparation: readiness,
    next_action: readiness.next_action,
  };
}

/** Carry original intent across async preparation; never replace it with a summary. */
export function writingContinueParams(topicId: string, req: WritingReadinessRequest): Record<string, unknown> {
  // An explicit empty string clears an inherited request. Omission or undefined
  // means inherit. Preserve that distinction through the host's next tool call.
  const carry = (key: keyof WritingReadinessRequest, target: string = key) =>
    req[key] !== undefined ? { [target]: req[key] } : {};
  return {
    topic_id: topicId,
    ...(req.platform ? { platform: req.platform } : {}),
    ...carry("direction"),
    ...carry("requirements"),
    ...carry("angleSkipReason", "skip_reason"),
    ...carry("research"),
    ...(req.researchMode ? { research_mode: req.researchMode } : {}),
    ...carry("researchReason", "research_reason"),
  };
}

/** Inspect only: this function never starts a model, research job or writing job. */
export async function inspectWritingReadiness(
  topicId: string,
  req: WritingReadinessRequest,
  dataDir: string,
  warn?: (message: string) => void,
): Promise<WritingReadiness> {
  const mode = req.researchMode ?? "auto";
  let continuation = writingContinueParams(topicId, req);
  const next = (action: string, extra: Record<string, unknown> = {}) => ({
    tool: "autocrew_workflow", params: { ...continuation, action, ...extra },
  });
  const result: WritingReadiness = {
    ready: false,
    status: "not_started",
    topicId,
    research: { mode, status: "not_started", autoResearched: false },
    angle: { status: "missing", cards: [] },
    note: "尚未调研；先准备材料和立意，再开始写稿。",
    next_action: next("prepare"),
    continue_params: continuation,
  };
  const topic = await getTopic(topicId, dataDir);
  if (!topic) {
    return { ...result, status: "needs_attention", note: `选题不存在：${topicId}`, next_action: { tool: "autocrew_topic", params: { action: "list" } } };
  }
  // 已有真稿的选题（存量、改稿、真稿的平台变体）先判：选题会只管第一篇（规则 8），
  // 存量稿身上旧的 skip / provided 元数据照旧可用，修订不能因为新规则被卡死
  let existingDraft: boolean;
  try { existingDraft = await topicHasDraft(topicId, dataDir); } catch (err) {
    return { ...result, status: "needs_attention", note: `${ANGLE_GATE_COPY.readFailed}（${err instanceof Error ? err.message : String(err)}）` };
  }
  // 跳过调研 / 跳过选卡的通道已关闭（选题会规则 6）：新稿明确拒绝，不静默当成 auto
  if (!existingDraft && (mode === "skip" || req.angleSkipReason?.trim() || req.researchReason?.trim())) {
    return { ...result, status: "needs_attention", note: ANGLE_GATE_COPY.skipRemoved, next_action: { tool: "autocrew_workflow", params: { topic_id: topicId, action: "prepare" } } };
  }
  if (!["auto", "provided", ...(existingDraft ? ["skip"] : [])].includes(mode)) {
    return { ...result, status: "needs_attention", note: "research_mode 仅支持 auto / provided。" };
  }
  const [job, snap] = await Promise.all([
    getJob(topicId, dataDir), resolveEffectiveBrief(topicId, dataDir, warn),
  ]);
  const task = createCreativeTask(req, job?.creativeTask ?? snap?.brief.creativeTask);
  // A new host conversation can resume from persisted intent without restating or summarizing it.
  req = inheritCreativeTask(req, task);
  continuation = writingContinueParams(topicId, req);
  result.continue_params = continuation;
  result.next_action = next("prepare");
  result.creativeTask = task;
  const topicHash = topicHashOf(topic.title, topic.description);
  const taskMatchesBrief = creativeTaskMatches(task, snap?.brief.creativeTask);
  const taskMatchesJob = creativeTaskMatches(task, job?.creativeTask);
  const stale = Boolean(snap && (snap.brief.topicHash !== topicHash || !taskMatchesBrief));
  result.research.creativeTaskHash = creativeTaskHash(task);
  const options = snap && !stale ? angleOptionsView(snap.brief) : { cards: [] };
  result.angle = { status: options.cards.length ? "needs_selection" : "missing", ...options };
  const effective = snap && !stale ? activeAngleCard(topic.selectedAngle, snap.brief, topicHash) : null;
  if (job) result.research.job = jobView(job);
  if (snap && (mode === "auto" || !stale)) Object.assign(result.research, {
    briefRevision: snap.revision,
    briefHash: snap.hash,
    summary: snap.brief.summary,
    gaps: snap.brief.gaps,
    sourceCount: new Set(snap.brief.evidence.map(e => e.sourceUrl).filter(Boolean)).size,
    stale,
  });

  if (mode === "provided") {
    if (!req.research?.trim()) {
      return { ...result, status: "needs_attention", note: "使用已有材料需在 research 中提供非空正文或可核查的来源摘录；不能把未调研说成已有材料。" };
    }
    result.research.status = "provided";
    result.research.reason = "使用宿主或创作者提供的材料；AutoCrew 未执行自动调研，来源仍需核查。";
  } else if (mode === "skip") {
    // 只有存量稿会走到这里（新稿在上面就被拒了）：沿用它当初免调研的设置做修订
    result.research.status = "skipped";
    result.research.reason = req.researchReason?.trim() || "存量稿沿用当初的免调研设置";
  } else {
    // A retained old brief is not proof that the latest requested research succeeded.
    if (job?.status === "queued" || job?.status === "running") {
      result.research.status = "running";
      result.research.matchesRequestedTask = taskMatchesJob;
      return { ...result, status: "researching", note: taskMatchesJob
        ? "调研正在进行，尚未完成；请先告知进度，不要直接写成稿。"
        : "正在进行的调研使用另一份创作任务，尚未应用本次要求。等待它结束后将按本次任务重新准备，不能把旧任务进度当成本次完成。", next_action: next("prepare") };
    }
    if (job?.status === "failed") {
      result.research.status = "failed";
      result.research.reason = job.failReason ?? job.errorCode ?? "最近一轮调研失败";
      return { ...result, status: "needs_attention", note: `最近一轮调研失败：${result.research.reason}。${snap ? "保留的旧简报不能代表本轮成功。" : "尚无可用简报。"}说明原因后，可明确重试 research。`, next_action: next("research", { kind: !stale && snap && job.kind === "angles" ? "angles" : "full" }) };
    }
    if (stale) {
      result.research.status = "stale";
      result.research.matchesRequestedTask = taskMatchesBrief;
      return { ...result, status: "not_started", note: "选题或本次创作任务（平台、要求、方向）已变化，旧简报已过期；需要按本次要求刷新调研。", next_action: next("prepare") };
    }
    if (!snap) {
      if (job) {
        result.research.status = "failed";
        return { ...result, status: "needs_attention", note: "调研任务已结束，但没有可读取的生效简报；不能当作材料已齐。请检查或重试调研。", next_action: next("research", { kind: "full" }) };
      }
      return result;
    }
    result.research.status = job?.status === "partial" ? "partial" : "complete";
    result.research.executedBy = snap.brief.executedBy ?? job?.executedBy ?? { kind: "engine" };
    result.research.autoResearched = result.research.executedBy.kind !== "host";
    result.research.matchesRequestedTask = true;
    if (angleCardsOf(snap.brief).length === 0 && !req.direction?.trim()) {
      return { ...result, status: "needs_attention", note: "调研已有简报，但没有形成可选立意；需要补跑立意，不能直接冒充写前准备完成。", next_action: next("research", { kind: "angles" }) };
    }
  }

  // 角度只认创始人亲口定的：带原话选的卡，或带原话记下的自定角度（选题会规则 4、5）
  const latest = latestDecision(topic);
  const authored = latest === "authored" && topic.founderAngle && founderChoiceOf({ ...topic, selectedAngle: undefined })?.kind === "authored" ? topic.founderAngle : null;
  const direction = req.direction?.trim() ?? "";
  const founderCard = effective && (existingDraft || (latest === "card" && topic.selectedAngle?.chosenBy === "founder" && topic.selectedAngle.founderWords?.trim())) ? effective : null;
  if (direction && (existingDraft || (authored && authored.direction === direction))) result.angle.status = "direction";
  else if (direction) {
    result.status = "needs_angle";
    result.note = ANGLE_GATE_COPY.bareDirection;
    result.next_action = next("select_angle", { direction, founder_words: "<创始人原话>" });
    return result;
  } else if (existingDraft && !founderCard) {
    // 存量稿修订：稿子本身就带着立意，不再要求选卡（旧的 skip_reason 也只当留痕）
    result.angle.status = "skipped";
    result.angle.reason = req.angleSkipReason?.trim() || "已有真稿的修订沿用原稿立意";
  } else if (founderCard) {
    result.angle.status = "selected";
    result.angle.selectedAngleId = founderCard.id;
    result.angle.selectedAngleHash = angleCardHash(founderCard);
  } else if (authored) {
    // 自定角度已记下，但这次没带那句 direction：照下一步带上再来，不暗中替换创作任务
    result.status = "needs_angle";
    result.note = "创始人已定了自己的角度；照 next_action 带上同一句 direction 继续。";
    result.next_action = next("prepare", { direction: authored.direction });
    return result;
  } else {
    result.status = "needs_angle";
    result.note = effective ? ANGLE_GATE_COPY.notFounderChoice : result.angle.cards.length
      ? "请向创始人展示每张卡的主张、证据、缺口、观众收获和数据依据，说明推荐理由；由他用原话选一张或给出自己的角度，不要替他选。"
      : "还没有立意卡：先按选题会出 3–4 张卡（自带材料也一样），由创始人定。";
    result.next_action = result.angle.cards.length ? next("select_angle", { brief_revision: snap!.revision, founder_words: "<创始人原话>" }) : next("prepare");
    return result;
  }
  result.ready = true;
  result.status = "ready_to_write";
  const preparationNote = mode === "auto" ? "调研与立意已准备好。" : result.research.reason + " ";
  result.note = `${preparationNote}由当前宿主领取写作包，按原始要求写稿；后台不会自动代写。`;
  result.next_action = { tool: "autocrew_writer", params: { ...continuation, action: "pack" } };
  return result;
}

/**
 * 开新稿的选题会闸口 + 就绪检查一起判：闸口拒了时，若写前准备本身也没就绪（还在调研 / 还有卡没选），
 * 回就绪检查那份更具体的结果（带候选卡与下一步）；就绪检查也过了才回闸口自己的拒绝。null = 放行。
 */
export async function newDraftGate(topicId: string, req: WritingReadinessRequest, dataDir: string, warn?: (m: string) => void): Promise<Record<string, unknown> | null> {
  const refused = await newDraftAngleRefusal(topicId, dataDir);
  if (!refused || refused.code !== "needs_founder_angle") return refused;
  const readiness = await inspectWritingReadiness(topicId, req, dataDir, warn);
  return readiness.ready ? refused : { ...writingReadinessFailure(readiness), gate: refused.code };
}
