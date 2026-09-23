/**
 * workflow-views.ts — `autocrew_workflow` 交给宿主模型的**形状**（dsh 插件 spec §4）。
 *
 * 单独一个文件不是为了整洁，是因为这几段有硬约束、且会被四处引用（status 的候选列表、
 * write 闸口的拒单摘要）：
 *
 * - **卡要给全**。宿主 agent 得照着念给创始人听——只报 id 和 thesis，人就没法选。
 * - 分数只用于展示排序；推荐另按可追溯证据给理由，永不替用户选择。
 * - **闸口的摘要要能塞进一个字符串**。dsh 桥把 `ok:false` 变成 `new Error(error)`，
 *   结构化字段全丢——候选念不出来的话，那一轮拒单就等于白拒。
 *
 * 全是纯函数、不读盘（稿件视图同理：只读传进来的那份 `Content`）。
 */
import { evidenceByRef, isAngleCardV3, type AngleCard, type ResearchBrief } from "../modules/research/brief-store.js";
import { DEFAULT_PERSONAS } from "../modules/research/personas.js";
import { isAnchorValid } from "../modules/research/angle-stage.js";
import { creativeTaskHash } from "../modules/writing/creative-task.js";
import { isTerminalJobStatus, type ResearchJob } from "../modules/research/research-job-store.js";
import { claimView } from "../storage/claims.js";
import { CONTENT_STATUS_LABEL, type Content } from "../storage/local-store.js";

export function jobView(job: ResearchJob): Record<string, unknown> {
  return {
    topicId: job.topicId,
    status: job.status,
    kind: job.kind ?? "full",
    executedBy: job.executedBy ?? { kind: "engine" },
    terminal: isTerminalJobStatus(job.status),
    briefRevision: job.briefRevision,
    creativeTask: job.creativeTask,
    creativeTaskHash: job.creativeTask ? creativeTaskHash(job.creativeTask) : undefined,
    perspectives: job.perspectives,
    errorCode: job.errorCode,
    failReason: job.failReason,
    // 兜底留痕（P2 spec §4.3）：这轮是备用端点顶上来的，宿主 agent 也该看得见
    usedFallback: job.usedFallback,
    startedAt: job.startedAt,
    settledAt: job.settledAt,
  };
}

/** 卡的完整读法：宿主 agent 要能照着念给创始人听，不是只报个 id */
export function cardView(card: AngleCard): Record<string, unknown> {
  const base = {
    id: card.id,
    angle: card.angle,
    thesis: card.thesis,
    antiScope: card.antiScope,
    hookDraft: card.hookDraft,
  };
  if (!isAngleCardV3(card)) {
    return { ...base, cardVersion: 2, audiencePain: card.audiencePain, holdTrigger: card.holdTrigger, hasAnchor: false };
  }
  return {
    ...base,
    cardVersion: 3,
    primaryPersona: card.primaryPersona,
    personaLabel: DEFAULT_PERSONAS[card.primaryPersona]?.name ?? card.primaryPersona,
    misconception: card.misconception,
    mechanism: card.mechanism,
    payoff: card.payoff,
    nextAction: card.nextAction,
    counterResponse: card.counterResponse,
    structure: card.structure,
    elements: card.elements,
    evidenceLevel: card.evidenceLevel,
    evidenceNeeds: card.evidenceNeeds,
    score: card.score,
    scoreReasons: card.scoreReasons,
    scoreMeaning: card.scoreReasons?.some(reason => reason.includes("证据支撑分")) ? "evidence_support" : "legacy_uninterpreted",
    scoreNotice: "该分数不能代表传播潜力或爆款概率；历史卡的评分规则可能不同",
    /** 有没有第一手锚点（创作者自己的转写/成稿）——P1b 之后这是「有没有私货」的判别位 */
    hasAnchor: Boolean(card.firsthandAnchor),
  };
}

/** 只按分排序（同分保持简报里的原序）。**不加推荐标**——挑哪张是创始人的活 */
export function sortedCards(cards: AngleCard[]): AngleCard[] {
  const scoreOf = (c: AngleCard): number => (isAngleCardV3(c) && typeof c.score === "number" ? c.score : -1);
  return [...cards].sort((a, b) => scoreOf(b) - scoreOf(a));
}

/** Explain the options and recommend on evidence coverage; never select a card. */
export function angleOptionsView(brief: ResearchBrief): {
  cards: Record<string, unknown>[];
  recommendation?: { angleId: string; reasons: string[]; basis: "evidence_coverage"; uncertainties: string[]; automaticSelection: false };
} {
  const options = sortedCards(brief.angleCards ?? []).map(card => {
    const refs = [...new Set(card.coreEvidenceIds)];
    const evidence = refs.map(ref => evidenceByRef(brief.evidence, ref))
      .filter(e => e !== null)
      .filter(e => e.source !== "user_claim")
      .filter(e => Boolean(e.claim.trim() && e.quote.trim() && e.sourceUrl.trim()));
    const fullyReferenced = refs.length > 0 && refs.length === evidence.length;
    const grounded = fullyReferenced && (!isAngleCardV3(card) || card.evidenceLevel === "grounded");
    const gaps = isAngleCardV3(card) ? card.evidenceNeeds : [];
    const hasFirsthand = isAngleCardV3(card) && isAnchorValid(card, brief);
    return {
      card,
      grounded,
      // Evidence completeness wins over cosmetic score; gaps and source diversity break ties.
      priority: [Number(grounded), Number(hasFirsthand), -gaps.length, new Set(evidence.map(e => e.sourceUrl)).size],
      view: {
        ...cardView(card),
        distinction: {
          thesis: card.thesis,
          antiScope: card.antiScope,
          audience: isAngleCardV3(card) ? "以创作任务和已确认账号画像为准；目标标签不代表实际人群" : card.audiencePain,
          ...(isAngleCardV3(card) ? { objective: DEFAULT_PERSONAS[card.primaryPersona]?.name ?? card.primaryPersona } : {}),
        },
        evidenceSupport: { completeReferences: fullyReferenced, count: evidence.length, sources: [...new Set(evidence.map(e => e.sourceUrl))], needs: gaps },
        editorialHypothesis: {
          status: "needs_creator_judgment",
          readerValue: isAngleCardV3(card) ? card.payoff : card.holdTrigger,
          opening: card.hookDraft,
          ...(isAngleCardV3(card) ? { structure: card.structure } : {}),
          uncertainty: "读者是否感兴趣、愿意读完或转发尚未验证；这些是编辑假设，不是效果预测",
        },
      },
      reasons: grounded ? [
        `主张有 ${evidence.length} 条简报证据可追溯`,
        ...(hasFirsthand ? ["包含引文锚点，可回查原文；锚点本身不证明主张或传播效果"] : []),
        ...(gaps.length ? [`仍需补齐：${gaps.join("；")}`] : ["立意卡未列出待补证据；写稿时仍须逐项核查事实"]),
      ] : [],
    };
  });
  const candidates = options.filter(o => o.grounded).sort((a, b) => {
    for (let i = 0; i < a.priority.length; i++) {
      const delta = b.priority[i] - a.priority[i];
      if (delta) return delta;
    }
    // 同等证据采用简报原顺序，不让历史网感分或目标偏好暗中决定推荐。
    const original = brief.angleCards ?? [];
    return original.indexOf(a.card) - original.indexOf(b.card);
  });
  const chosen = candidates[0];
  return {
    cards: options.map(o => o.view),
    ...(chosen ? { recommendation: {
      angleId: chosen.card.id,
      reasons: chosen.reasons,
      basis: "evidence_coverage" as const,
      uncertainties: ["推荐仅比较证据覆盖，不评定哪个角度最有传播潜力", "与本次规划的贴合度、受众价值和表达取舍仍须创作者判断"],
      automaticSelection: false as const,
    } } : {}),
  };
}

/** 闸口拒单时塞进 error 文本的一行摘要（dsh 桥只把 error 带给模型） */
export function cardLine(card: AngleCard): string {
  const who = isAngleCardV3(card)
    ? `${DEFAULT_PERSONAS[card.primaryPersona]?.name ?? card.primaryPersona}${card.misconception ? `｜误区背景：${card.misconception}` : ""}`
    : card.audiencePain;
  return `${card.id}【${card.angle}】主张：${card.thesis}｜${isAngleCardV3(card) ? "内容目标" : "对谁说"}：${who}｜不写：${card.antiScope}`;
}

// ─── 稿件视图（draft / writer） ───────────────────────────────────────────────

/** 「谁写的」的人话名——`writtenBy` 的两种形态各说各的事，读侧不分支 */
function writerLabel(writtenBy: Content["writtenBy"]): string {
  if (!writtenBy) return "未知";
  return writtenBy.kind === "host" ? writtenBy.host : `引擎 ${writtenBy.provider}/${writtenBy.model}`;
}

function minutesSince(iso: string): number {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 60_000));
}

/** 包发出去了、稿还没回来（P3 §5.3）：`drafting` + 有包 + 没 `submittedAt` */
export function packOutstanding(content: Content): boolean {
  return content.status === "drafting" && Boolean(content.pack) && !content.pack?.submittedAt;
}

/**
 * 新提交记录明确的等待标记，包含revision状态下重交的一稿；旧记录保留原判据。
 */
export function reviewOutstanding(content: Content): boolean {
  if (content.pack?.reviewPending !== undefined) return content.pack.reviewPending;
  return content.status === "drafting" && Boolean(content.pack?.submittedAt);
}

/**
 * `drafting` 的那一句话。三种「写作中」的成因完全不同，说错就是让人白等：
 * 内部写手 = 真有个后台任务在跑；宿主写稿 = 除了发包那几分钟的备料，球都在宿主模型那边；
 * 交了稿的按实际 reviewMode 指向宿主审阅或明确启用的后台线。这里不读盘（纯函数）。
 */
export function draftingNote(content: Content): string {
  if (reviewOutstanding(content)) {
    if (content.pack?.reviewMode === "host") return "正文已保存，等待当前宿主审稿。请调用 `autocrew_review_desk pack` 领取材料，再提交定位到原文的问题；等待或轮询不会启动后台模型。";
    if (content.pack?.reviewMode === "none") return "正文已保存，本次明确跳过审稿；不能将保存成功当作质量通过。用 `autocrew_writer submit_status` 查看保存结果。";
    return `稿已交，审稿中（${minutesSince(content.pack!.submittedAt!)} 分钟）。审稿在后台跑（通常 1–3 分钟），\`autocrew_writer submit_status\` 看得到结论；出结论后这篇会自动转草稿就绪或退回修订。`;
  }
  if (content.review?.status === "stale") return "正文已变化，旧审稿结论已经失效。请重新领取当前稿的写作包、提交并审阅，不能沿用旧结论。";
  if (content.pack?.submittedAt && content.pack.reviewPending === false) return "正文已保存，当前没有等待中的审稿任务。用 `autocrew_writer submit_status` 查看结论和需要处理的事项。";
  if (!packOutstanding(content)) {
    return "还在后台写（通常 15–30 分钟），过一会儿再查。正文此刻是占位，别拿去用。";
  }
  const pack = content.pack!;
  return `写作包已发给 ${pack.host}，未收到稿（${minutesSince(pack.issuedAt)} 分钟）。刚发包的头几分钟产品还在备料（\`autocrew_writer pack_status\` 看得到）；备好之后球就在宿主那边——催他提交，或 pack{force:true} 再领一次（旧包作废）。`;
}

/** 「谁在写、领的哪份包、谁在拿着它」——`drafting` 的占位回执与成稿视图都带上它 */
export function draftOwnerView(content: Content): Record<string, unknown> {
  return {
    writtenBy: content.writtenBy,
    writtenByLabel: writerLabel(content.writtenBy),
    pack: content.pack,
    packOutstanding: packOutstanding(content),
    ...(reviewOutstanding(content) ? {
      reviewPending: content.pack?.reviewMode === "host" ? "awaiting_host_review" : content.pack?.reviewMode === "none" ? "unreviewed" : "reviewing",
      reviewNextAction: content.pack?.reviewMode === "host"
        ? { tool: "autocrew_review_desk", params: { action: "pack", content_id: content.id } }
        : { tool: "autocrew_writer", params: { action: "submit_status", content_id: content.id } },
    } : {}),
    // 认领与交接（P3 §6.1）。`claimView` 抹掉令牌——它只回给认领者本人
    claim: claimView(content.claim),
    handoffs: content.handoffs ?? [],
  };
}

/** 取稿视图（`autocrew_workflow draft` 与 `autocrew_writer submit` 共用的成稿形状） */
export function draftView(content: Content): Record<string, unknown> {
  return {
    contentId: content.id,
    status: content.status,
    statusLabel: CONTENT_STATUS_LABEL[content.status] ?? content.status,
    title: content.title,
    body: content.body,
    hashtags: content.hashtags,
    review: content.review,
    needsEvidence: content.status === "needs_evidence",
    unverifiedNumbers: content.unverifiedNumbers ?? [],
    blockedReason: content.blockedReason ?? undefined,
    lastError: content.lastError ?? undefined,
    usedAngle: content.usedAngle,
    usedFallback: content.usedFallback,
    ...draftOwnerView(content),
  };
}
