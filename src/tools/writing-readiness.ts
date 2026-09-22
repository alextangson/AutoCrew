/** Shared, read-only preparation gate for every MCP writing entry. */
import { activeAngleCard, angleCardHash, angleCardsOf } from "../modules/research/angle-cards.js";
import { resolveEffectiveBrief } from "../modules/research/brief-snapshot.js";
import { getJob, topicHashOf } from "../modules/research/research-job-store.js";
import { getTopic } from "../storage/local-store.js";
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
  research: {
    mode: "auto" | "provided" | "skip";
    status: "not_started" | "running" | "failed" | "stale" | "complete" | "partial" | "provided" | "skipped";
    /** True only when AutoCrew has a current successful/partial brief. */
    autoResearched: boolean;
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
    needsResearch: readiness.research.mode === "auto" && !readiness.research.autoResearched,
    status: readiness.status,
    briefRevision: readiness.research.briefRevision,
    cards: readiness.angle.cards,
    preparation: readiness,
    next_action: readiness.next_action,
  };
}

/** Carry original intent across async preparation; never replace it with a summary. */
export function writingContinueParams(topicId: string, req: WritingReadinessRequest): Record<string, unknown> {
  // An explicit empty/undefined own field clears an inherited request. Omission
  // means inherit. Preserve that distinction through the host's next tool call.
  const carry = (key: keyof WritingReadinessRequest, target: string = key) =>
    Object.prototype.hasOwnProperty.call(req, key) ? { [target]: req[key] ?? "" } : {};
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
  const continuation = writingContinueParams(topicId, req);
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
  if (!["auto", "provided", "skip"].includes(mode)) {
    return { ...result, status: "needs_attention", note: "research_mode 仅支持 auto / provided / skip。" };
  }
  const [job, snap] = await Promise.all([
    getJob(topicId, dataDir), resolveEffectiveBrief(topicId, dataDir, warn),
  ]);
  const topicHash = topicHashOf(topic.title, topic.description);
  const stale = Boolean(snap && snap.brief.topicHash !== topicHash);
  const options = snap && !stale ? angleOptionsView(snap.brief) : { cards: [] };
  result.angle = { status: options.cards.length ? "needs_selection" : "missing", ...options };
  const effective = snap && !stale ? activeAngleCard(topic.selectedAngle, snap.brief, topicHash) : null;
  if (job) result.research.job = jobView(job);
  if (snap) Object.assign(result.research, {
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
    if (!req.researchReason?.trim()) {
      return { ...result, status: "needs_attention", note: "跳过调研需 research_reason 记录创作者明确的要求；不能由 agent 自行假定。" };
    }
    result.research.status = "skipped";
    result.research.reason = req.researchReason;
  } else {
    // A retained old brief is not proof that the latest requested research succeeded.
    if (job?.status === "queued" || job?.status === "running") {
      result.research.status = "running";
      return { ...result, status: "researching", note: "调研正在进行，尚未完成；请先告知进度，不要直接写成稿。", next_action: next("prepare") };
    }
    if (job?.status === "failed") {
      result.research.status = "failed";
      result.research.reason = job.failReason ?? job.errorCode ?? "最近一轮调研失败";
      return { ...result, status: "needs_attention", note: `最近一轮调研失败：${result.research.reason}。${snap ? "保留的旧简报不能代表本轮成功。" : "尚无可用简报。"}说明原因后，可明确重试 research。`, next_action: next("research", { kind: !stale && snap && job.kind === "angles" ? "angles" : "full" }) };
    }
    if (stale) {
      result.research.status = "stale";
      return { ...result, status: "not_started", note: "选题标题或描述已变化，旧简报已过期；需要刷新调研。", next_action: next("prepare") };
    }
    if (!snap) {
      if (job) {
        result.research.status = "failed";
        return { ...result, status: "needs_attention", note: "调研任务已结束，但没有可读取的生效简报；不能当作材料已齐。请检查或重试调研。", next_action: next("research", { kind: "full" }) };
      }
      return result;
    }
    result.research.status = job?.status === "partial" ? "partial" : "complete";
    result.research.autoResearched = true;
    if (angleCardsOf(snap.brief).length === 0 && !req.direction?.trim() && !req.angleSkipReason?.trim()) {
      return { ...result, status: "needs_attention", note: "调研已有简报，但没有形成可选立意；需要补跑立意，不能直接冒充写前准备完成。", next_action: next("research", { kind: "angles" }) };
    }
  }

  if (req.direction?.trim()) result.angle.status = "direction";
  else if (effective) {
    result.angle.status = "selected";
    result.angle.selectedAngleId = effective.id;
    result.angle.selectedAngleHash = angleCardHash(effective);
  } else if (req.angleSkipReason?.trim()) {
    result.angle.status = "skipped";
    result.angle.reason = req.angleSkipReason;
  } else {
    result.status = "needs_angle";
    result.note = result.angle.cards.length
      ? "请向创作者展示候选之间的主张、适用受众和证据差异，并说明推荐理由；由他选择或给出自己的方向，不要替他选。"
      : "已有材料或跳过调研不等于已确定立意。请基于现有材料给出不同方向，由创作者确定 direction；只有他明确不选时才填 skip_reason。";
    result.next_action = result.angle.cards.length ? next("select_angle", { brief_revision: snap!.revision }) : next("prepare");
    return result;
  }
  result.ready = true;
  result.status = "ready_to_write";
  const preparationNote = mode === "auto" ? "调研与立意已准备好。"
    : mode === "skip" ? `本次按创作者要求跳过调研，AutoCrew 未执行自动调研：${result.research.reason}。`
    : result.research.reason + " ";
  result.note = `${preparationNote}由当前宿主领取写作包，按原始要求写稿；后台不会自动代写。`;
  result.next_action = { tool: "autocrew_writer", params: { ...continuation, action: "pack" } };
  return result;
}
