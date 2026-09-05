/**
 * workflow-views.ts — `autocrew_workflow` 交给宿主模型的**形状**（dsh 插件 spec §4）。
 *
 * 单独一个文件不是为了整洁，是因为这几段有硬约束、且会被四处引用（status 的候选列表、
 * write 闸口的拒单摘要）：
 *
 * - **卡要给全**。宿主 agent 得照着念给创始人听——只报 id 和 thesis，人就没法选。
 * - **只按 score 排序，不加推荐标**。分是代码打的、只用于排序（P1 §3.1 codex #7）；
 *   排第一不等于该选它，挑哪张是创始人的活。
 * - **闸口的摘要要能塞进一个字符串**。dsh 桥把 `ok:false` 变成 `new Error(error)`，
 *   结构化字段全丢——候选念不出来的话，那一轮拒单就等于白拒。
 *
 * 全是纯函数、不读盘。
 */
import { isAngleCardV3, type AngleCard } from "../modules/research/brief-store.js";
import { DEFAULT_PERSONAS } from "../modules/research/personas.js";
import { isTerminalJobStatus, type ResearchJob } from "../modules/research/research-job-store.js";

export function jobView(job: ResearchJob): Record<string, unknown> {
  return {
    topicId: job.topicId,
    status: job.status,
    kind: job.kind ?? "full",
    terminal: isTerminalJobStatus(job.status),
    briefRevision: job.briefRevision,
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
    /** 有没有第一手锚点（创作者自己的转写/成稿）——P1b 之后这是「有没有私货」的判别位 */
    hasAnchor: Boolean(card.firsthandAnchor),
  };
}

/** 只按分排序（同分保持简报里的原序）。**不加推荐标**——挑哪张是创始人的活 */
export function sortedCards(cards: AngleCard[]): AngleCard[] {
  const scoreOf = (c: AngleCard): number => (isAngleCardV3(c) && typeof c.score === "number" ? c.score : -1);
  return [...cards].sort((a, b) => scoreOf(b) - scoreOf(a));
}

/** 闸口拒单时塞进 error 文本的一行摘要（dsh 桥只把 error 带给模型） */
export function cardLine(card: AngleCard): string {
  const who = isAngleCardV3(card)
    ? `${DEFAULT_PERSONAS[card.primaryPersona]?.name ?? card.primaryPersona}｜他信的是：${card.misconception}`
    : card.audiencePain;
  return `${card.id}【${card.angle}】主张：${card.thesis}｜对谁说：${who}｜不写：${card.antiScope}`;
}
