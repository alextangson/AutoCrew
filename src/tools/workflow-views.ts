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
 * 全是纯函数、不读盘（稿件视图同理：只读传进来的那份 `Content`）。
 */
import { isAngleCardV3, type AngleCard } from "../modules/research/brief-store.js";
import { DEFAULT_PERSONAS } from "../modules/research/personas.js";
import { isTerminalJobStatus, type ResearchJob } from "../modules/research/research-job-store.js";
import { CONTENT_STATUS_LABEL, type Content } from "../storage/local-store.js";

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
 * `drafting` 的那一句话。两种「写作中」的成因完全不同，说错就是让人白等：
 * 内部写手 = 真有个后台任务在跑；宿主写稿 = 球在宿主模型那边，产品这边什么都没在跑。
 */
export function draftingNote(content: Content): string {
  if (!packOutstanding(content)) {
    return "还在后台写（通常 15–30 分钟），过一会儿再查。正文此刻是占位，别拿去用。";
  }
  const pack = content.pack!;
  return `写作包已发给 ${pack.host}，未收到稿（${minutesSince(pack.issuedAt)} 分钟）。产品这边没有在跑的后台任务——催宿主提交，或再领一次包（旧包作废）。`;
}

/** 「谁在写、领的哪份包」——`drafting` 的占位回执与成稿视图都带上它 */
export function draftOwnerView(content: Content): Record<string, unknown> {
  return {
    writtenBy: content.writtenBy,
    writtenByLabel: writerLabel(content.writtenBy),
    pack: content.pack,
    packOutstanding: packOutstanding(content),
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
