/**
 * 消化管线（spec §3.1–§3.4）——把一条已落账的 inbox item 变成「结构化落点 + 回执」。
 *
 * worker 注入本模块产出的 `processItem` 并**串行**调用，所以这里不需要任何锁；
 * item 交到 worker 之后归 worker 独占写，因此管线自己写台账（canonicalUrl / receiptStatus）
 * 也不会与别人打架——但只能写 worker 不写的字段，status/attempts/stage 一律由 worker
 * 按返回的 ProcessResult 落盘。
 *
 * 三条纪律：
 * 1. **三态语义不共用 failed**（§3.1）：确定性拒绝 → rejected，等外部条件 → blocked，
 *    可重试故障 → failed。映射表见 `classifyError`，是验收项，不许随手改。
 * 2. **断点续做**：`both` 的卡步做完就把 stage=card_done 随结果（含失败结果）带回，
 *    重试时跳过卡步；卡本身也按 sourceInboxId 幂等，重跑不会产生第二张。
 * 3. **回执是旁路**：发失败只标 receiptStatus=failed，绝不回滚消化结果（§2.1）。
 *
 * V1.0 不为 x.com / douyin.com 做特判——没有专用解析器就走通用抓取，抓不到正文自然
 * 落 rejected/failed，解析器 V1.1 才上（§3.2/§7）。这里**不能**给这两个域名硬编 blocked。
 */
import { loadProfile, type CreatorProfile } from "../profile/creator-profile.js";
import {
  findPatternByCanonicalUrl,
  upsertPatternCard,
  type PatternCard,
  type PatternCardInput,
} from "../patterns/pattern-store.js";
import { gateTopicCandidate, type GateResult, type TopicCandidate } from "../radar/intake-gate.js";
import { FetchExternalError, fetchExternalPage, type ExternalPage } from "./fetch-external.js";
import {
  findByCanonicalUrl,
  findByTextHash,
  updateItem,
  type InboxItem,
  type InboxStage,
  type InboxVerdict,
} from "./inbox-store.js";
import { MAX_ATTEMPTS, type ProcessResult } from "./inbox-worker.js";
import { sendTelegramReceipt, type TelegramClientOptions } from "./telegram-api.js";
import {
  EngineUnavailableError,
  TriageError,
  triageInboxContent,
  type TriageInput,
  type TriageOptions,
  type TriageResult,
} from "./triage.js";
import { canonicalizeUrl, normalizeTextForHash } from "./url-canonical.js";

// ─── 契约类型 ────────────────────────────────────────────────────────────────

/** 状态落定事件；C2 接 SSE（总线不在本模块接） */
export interface InboxUpdatedEvent {
  type: "inbox:updated";
  itemId: string;
}

/** 回执通道配置（缺省 = 不发回执，扩展来源本来就没有 chatId） */
export type DigestTelegramConfig = Pick<TelegramClientOptions, "botToken" | "proxyUrl" | "apiBaseUrl">;

export interface DigestPatternStore {
  upsert(input: PatternCardInput, dataDir?: string): Promise<PatternCard>;
  findByCanonicalUrl(canonicalUrl: string, dataDir?: string): Promise<PatternCard | null>;
}

export interface DigestPipelineDeps {
  /** 固定工作区（§2.1 targetWorkspaceId） */
  dataDir: string;
  telegram?: DigestTelegramConfig;
  fetchImpl?: (url: string) => Promise<ExternalPage>;
  triageImpl?: (input: TriageInput, opts?: TriageOptions) => Promise<TriageResult>;
  gateImpl?: (candidate: TopicCandidate, dataDir?: string) => Promise<GateResult>;
  patternStore?: DigestPatternStore;
  loadProfileImpl?: (dataDir?: string) => Promise<CreatorProfile | null>;
  sendReceiptImpl?: (chatId: number, text: string, opts: TelegramClientOptions) => Promise<boolean>;
  onEvent?: (evt: InboxUpdatedEvent) => void;
  /** 回执/台账等旁路故障的出口——不静默（默认 console.error） */
  onError?: (message: string) => void;
}

// ─── 回执文案（常量，改文案只改这里） ────────────────────────────────────────

const VERDICT_LABEL: Record<InboxVerdict, string> = {
  inspiration: "灵感选题",
  exemplar: "对标拆解卡",
  both: "拆解卡 + 灵感选题",
  unusable: "用不上",
};

export const DIGEST_RECEIPTS = {
  digested: (verdict: InboxVerdict, landings: string[]): string =>
    `已消化 · ${VERDICT_LABEL[verdict]}\n落点：${landings.join("；") || "（无）"}`,
  alreadyDigested: (where: string): string => `已收录过，这次没重复入库\n原落点：${where}`,
  rejected: (reason: string): string => `这条没收下：${reason}`,
  failed: (reason: string): string => `这条暂时没处理成功：${reason}\n会自动重试，不用重发`,
  /** 重试额度已用尽——别再承诺「会自动重试」，指向人工入口 */
  failedFinal: (reason: string): string =>
    `这条试了 ${MAX_ATTEMPTS} 次都没成功：${reason}\n去工作台收件箱里手动重试`,
  blocked: (reason: string, hint: string): string => `这条先挂起：${reason}\n${hint}`,
  /** 墓碑命中：显式覆盖而非静默复活（§3.5） */
  tombstone: "此前拆解卡已删除；要重拆请重新转发并附『重拆』备注",
  topicRejectMemory: "这个选题 7 天内评估过并落选了，暂不重复入库",
  emptyItem: "这条既没有链接也没有文字，没法消化",
} as const;

const ENGINE_BLOCKED_HINT = "去设置页把引擎（模型 / 中转地址 / API key）配好，保存后会自动重试。";

// ─── 内部形态 ────────────────────────────────────────────────────────────────

/** 一次消化的产出：给 worker 的结论 + 给创始人的人话 */
interface Outcome {
  result: ProcessResult;
  receipt: string;
}

/** 跨步骤累积的进度——失败时也要随结果带回台账，否则 checkpoint 丢了要重跑卡步 */
interface Progress {
  stage?: InboxStage;
  targetIds: string[];
  /** 人话落点，只进回执 */
  landings: string[];
}

interface Ctx {
  dataDir: string;
  fetchPage: NonNullable<DigestPipelineDeps["fetchImpl"]>;
  triage: NonNullable<DigestPipelineDeps["triageImpl"]>;
  gate: NonNullable<DigestPipelineDeps["gateImpl"]>;
  patterns: DigestPatternStore;
  loadProfile: NonNullable<DigestPipelineDeps["loadProfileImpl"]>;
}

/** 纯文字笔记的选题标题：正文前 30 字（按码点切，别把代理对劈一半） */
const TEXT_TITLE_CHARS = 30;
/** 备注里带这两个词 = 创始人显式要求重拆，绕开全部查重（§3.5 显式覆盖） */
const REDO_RE = /重拆|redo/i;

function carry(progress: Progress): Pick<ProcessResult, "stage" | "targetIds"> {
  return {
    ...(progress.stage ? { stage: progress.stage } : {}),
    ...(progress.targetIds.length ? { targetIds: progress.targetIds } : {}),
  };
}

function rejectedOutcome(reason: string, errorCode: string, progress: Progress): Outcome {
  return {
    result: { status: "rejected", errorCode, failReason: reason, ...carry(progress) },
    receipt: DIGEST_RECEIPTS.rejected(reason),
  };
}

function duplicateOutcome(where: string, targetIds: string[], verdict?: InboxVerdict): Outcome {
  return {
    result: { status: "digested", ...(verdict ? { verdict } : {}), targetIds },
    receipt: DIGEST_RECEIPTS.alreadyDigested(where),
  };
}

// ─── 错误映射（三态语义，验收项） ────────────────────────────────────────────

/** 确定性抓取失败：重试也不会变，直接 rejected */
const DETERMINISTIC_FETCH = new Set([
  "invalid_url",
  "unsupported_protocol",
  "ssrf_blocked",
  "unsupported_content_type",
  "body_too_large",
  "too_many_redirects",
]);

const FETCH_REASON: Record<string, string> = {
  invalid_url: "这个链接解析不了",
  unsupported_protocol: "只吃 http/https 链接",
  ssrf_blocked: "这个地址指向本机或内网，出于安全没抓",
  unsupported_content_type: "这个链接不是网页正文（只吃 HTML / 纯文本）",
  body_too_large: "页面超过 2MB 上限，已中止",
  too_many_redirects: "跳转超过 5 跳，已放弃",
  timeout: "抓取超时",
  fetch_failed: "抓不到这个页面（网络或对方站点问题）",
};

/** http_<n>：4xx 是对方明确拒绝（确定性），5xx/其它按可重试处理 */
function httpStatusOf(errorCode: string): number | null {
  const m = /^http_(\d{3})$/.exec(errorCode);
  return m ? Number(m[1]) : null;
}

function fetchReason(err: FetchExternalError): string {
  const http = httpStatusOf(err.errorCode);
  return http !== null ? `对方站点返回 ${http}` : (FETCH_REASON[err.errorCode] ?? err.message);
}

interface Classified {
  status: "rejected" | "failed" | "blocked";
  errorCode: string;
  reason: string;
  receipt: string;
}

/** failed 的回执文案取决于「还有没有下一次」——worker 的 retryable 口径同款 */
function failedReceipt(reason: string, willRetry: boolean): string {
  return willRetry ? DIGEST_RECEIPTS.failed(reason) : DIGEST_RECEIPTS.failedFinal(reason);
}

/**
 * 错误 → 三态。判错方向的默认值一律偏「可见地重试几次」（failed），
 * 而不是永久 rejected——把能救的判死比多跑两次贵得多。
 */
function classifyError(err: unknown, willRetry: boolean): Classified {
  if (err instanceof FetchExternalError) {
    const http = httpStatusOf(err.errorCode);
    const deterministic = DETERMINISTIC_FETCH.has(err.errorCode) || (http !== null && http < 500);
    const reason = fetchReason(err);
    return deterministic
      ? { status: "rejected", errorCode: err.errorCode, reason, receipt: DIGEST_RECEIPTS.rejected(reason) }
      : { status: "failed", errorCode: err.errorCode, reason, receipt: failedReceipt(reason, willRetry) };
  }
  if (err instanceof EngineUnavailableError) {
    return {
      status: "blocked",
      errorCode: err.errorCode,
      reason: err.message,
      receipt: DIGEST_RECEIPTS.blocked(err.message, ENGINE_BLOCKED_HINT),
    };
  }
  if (err instanceof TriageError) {
    const reason = err.message;
    return err.retryable
      ? { status: "failed", errorCode: err.errorCode, reason, receipt: failedReceipt(reason, willRetry) }
      : { status: "rejected", errorCode: err.errorCode, reason, receipt: DIGEST_RECEIPTS.rejected(reason) };
  }
  const reason = err instanceof Error ? err.message : String(err);
  return { status: "failed", errorCode: "digest_failed", reason, receipt: failedReceipt(reason, willRetry) };
}

/** attempts 是 worker claim 时已经 +1 过的「本次是第几次」，与它的 retryable 同口径 */
function failureOutcome(err: unknown, progress: Progress, attempts: number): Outcome {
  const c = classifyError(err, attempts < MAX_ATTEMPTS);
  return {
    result: { status: c.status, errorCode: c.errorCode, failReason: c.reason, ...carry(progress) },
    receipt: c.receipt,
  };
}

// ─── 纯文字笔记 ──────────────────────────────────────────────────────────────

function clampChars(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
}

/**
 * 随手记：7 天窗口内的同文去重（§2.1），否则直接进灵感库单条门——
 * 没有链接可抓、也没有对标可拆，不劳驾 LLM。
 */
async function digestText(ctx: Ctx, item: InboxItem, progress: Progress): Promise<Outcome> {
  const text = item.text ?? "";
  const twin = await findByTextHash(normalizeTextForHash(text), ctx.dataDir);
  // 与链接路径同口径：只有**落过点**的孪生记录才算「已收录过」，
  // 前一条 failed/rejected 时说这句等于把两条都悄悄丢掉
  if (twin && twin.id !== item.id && twin.status === "digested") {
    return duplicateOutcome(twin.targetIds?.join("、") || twin.id, twin.targetIds ?? [], "inspiration");
  }
  const title = clampChars(text, TEXT_TITLE_CHARS);
  const gated = await ctx.gate(
    { title, summary: text, source: `inbox:${item.source}`, reason: "收件箱 · 随手记" },
    ctx.dataDir,
  );
  if (gated.saved) {
    progress.targetIds.push(gated.topicId);
    return {
      result: { status: "digested", verdict: "inspiration", targetIds: progress.targetIds },
      receipt: DIGEST_RECEIPTS.digested("inspiration", [`灵感《${title}》`]),
    };
  }
  if (gated.code === "duplicate") {
    return duplicateOutcome(gated.existingId ?? "既有灵感", gated.existingId ? [gated.existingId] : [], "inspiration");
  }
  return rejectedOutcome(DIGEST_RECEIPTS.topicRejectMemory, "reject_memory", progress);
}

// ─── 链接：三库查重 ──────────────────────────────────────────────────────────

function wantsRedo(note?: string): boolean {
  return Boolean(note && REDO_RE.test(note));
}

/**
 * 查重顺序：墓碑 → inbox 台账 → 在库拆解卡；topics 由入库门自己兜（§3.4）。
 * 墓碑排在最前是因为它的结论最具体也最可操作——同链接删卡后再转发，命中的必然
 * 既有墓碑又有那条早已 digested 的台账记录，让「已收录过」赢会把重拆指引吞掉。
 * 三条都排除 item 自己：重试/续做时自己写下的 canonicalUrl 与卡不是「别人的重复」。
 */
async function findDuplicate(ctx: Ctx, item: InboxItem, canonicalUrl: string): Promise<Outcome | null> {
  const card = await ctx.patterns.findByCanonicalUrl(canonicalUrl, ctx.dataDir);
  const foreignCard = card && card.sourceInboxId !== item.id ? card : null;
  if (foreignCard?.deletedAt) {
    return {
      result: { status: "rejected", errorCode: "pattern_tombstone", failReason: DIGEST_RECEIPTS.tombstone },
      receipt: DIGEST_RECEIPTS.tombstone,
    };
  }
  const twin = await findByCanonicalUrl(canonicalUrl, ctx.dataDir);
  if (twin && twin.id !== item.id && twin.status === "digested") {
    return duplicateOutcome(twin.targetIds?.join("、") || twin.id, twin.targetIds ?? [], twin.verdict);
  }
  if (foreignCard) return duplicateOutcome(`拆解卡《${foreignCard.title}》`, [foreignCard.id], "exemplar");
  return null;
}

// ─── 链接：抓取 → 分流 → 落库 ────────────────────────────────────────────────

async function digestUrl(ctx: Ctx, item: InboxItem, progress: Progress): Promise<Outcome> {
  const sourceUrl = item.url ?? "";
  const page = await ctx.fetchPage(sourceUrl);
  const canonicalUrl = canonicalizeUrl(page.finalUrl);
  // 幂等键先落账：崩在分流途中，重跑也认得这条是谁（§3.1）
  if (item.canonicalUrl !== canonicalUrl) await updateItem(item.id, { canonicalUrl }, ctx.dataDir);

  if (!wantsRedo(item.note)) {
    const duplicate = await findDuplicate(ctx, item, canonicalUrl);
    if (duplicate) return duplicate;
  }

  const profile = await ctx.loadProfile(ctx.dataDir);
  const triaged = await ctx.triage(
    {
      content: {
        text: page.text,
        ...(page.title ? { title: page.title } : {}),
        sourceUrl,
        finalUrl: page.finalUrl,
      },
      ...(item.note ? { note: item.note } : {}),
      profile,
    },
    { dataDir: ctx.dataDir },
  );
  return routeVerdict(ctx, item, canonicalUrl, triaged, progress);
}

/** 卡步：stage=card_done 就跳过（续做）；落卡按 sourceInboxId 幂等，重跑不产生第二张 */
async function runCardStep(
  ctx: Ctx,
  item: InboxItem,
  canonicalUrl: string,
  triaged: TriageResult,
  progress: Progress,
): Promise<void> {
  const card = triaged.card;
  if (!card) return; // 契约由 triage 的条件校验兜住，这里只是不让类型漏气
  if (progress.stage === "card_done") {
    progress.landings.push(`拆解卡《${card.title}》（已存在）`);
    return;
  }
  const saved = await ctx.patterns.upsert(
    {
      ...card,
      sourceUrl: item.url ?? canonicalUrl,
      canonicalUrl,
      sourceInboxId: item.id,
      ...(item.note ? { founderNote: item.note } : {}),
    },
    ctx.dataDir,
  );
  progress.stage = "card_done";
  if (!progress.targetIds.includes(saved.id)) progress.targetIds.push(saved.id);
  progress.landings.push(`拆解卡《${saved.title}》`);
}

/** 题步：入库门说了算。返回非空 = 该子步没落库的人话原因 */
async function runTopicStep(
  ctx: Ctx,
  item: InboxItem,
  canonicalUrl: string,
  triaged: TriageResult,
  progress: Progress,
): Promise<string | null> {
  const topic = triaged.topic;
  if (!topic) return null;
  const note = item.note?.trim();
  const gated = await ctx.gate(
    {
      title: topic.title,
      summary: topic.summary,
      angle: topic.angle,
      link: canonicalUrl,
      source: `inbox:${item.source}`,
      reason: `收件箱 · 转发${note ? ` · ${note}` : ""}`,
    },
    ctx.dataDir,
  );
  if (gated.saved) {
    progress.targetIds.push(gated.topicId);
    progress.landings.push(`灵感《${topic.title}》`);
  } else if (gated.code === "duplicate") {
    // 门说重复 = 该子步已完成，回执指向原落点（§3.1 各端各自幂等）
    if (gated.existingId && !progress.targetIds.includes(gated.existingId)) progress.targetIds.push(gated.existingId);
    progress.landings.push(`灵感《${topic.title}》（已收录过：${gated.existingId ?? "既有条目"}）`);
  } else {
    return DIGEST_RECEIPTS.topicRejectMemory;
  }
  progress.stage = "topic_done";
  return null;
}

async function routeVerdict(
  ctx: Ctx,
  item: InboxItem,
  canonicalUrl: string,
  triaged: TriageResult,
  progress: Progress,
): Promise<Outcome> {
  const { verdict } = triaged;
  if (verdict === "unusable") {
    const reason = triaged.reason ?? "内容太薄或与定位无关";
    return {
      result: { status: "rejected", verdict, errorCode: "unusable", failReason: reason, ...carry(progress) },
      receipt: DIGEST_RECEIPTS.rejected(reason),
    };
  }
  if (verdict === "exemplar" || verdict === "both") {
    await runCardStep(ctx, item, canonicalUrl, triaged, progress);
  }
  if (verdict === "inspiration" || verdict === "both") {
    const blockedReason = await runTopicStep(ctx, item, canonicalUrl, triaged, progress);
    // 一个落点都没有 = 整条没收下；卡已落库则只是少了半边，仍算消化完成
    if (blockedReason && progress.targetIds.length === 0) {
      return rejectedOutcome(blockedReason, "reject_memory", progress);
    }
    if (blockedReason) progress.landings.push(`灵感未入库（${blockedReason}）`);
  }
  return {
    result: { status: "digested", verdict, ...carry(progress) },
    receipt: DIGEST_RECEIPTS.digested(verdict, progress.landings),
  };
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 造一个 `processItem` 交给 worker。本函数**永不抛**：任何异常都被映射成三态之一
 * 落进台账并回执，静默丢消息是这条管线唯一不可接受的失败模式（§0.2）。
 */
export function createDigestPipeline(deps: DigestPipelineDeps): (item: InboxItem) => Promise<ProcessResult> {
  const ctx: Ctx = {
    dataDir: deps.dataDir,
    fetchPage: deps.fetchImpl ?? ((url) => fetchExternalPage(url)),
    triage: deps.triageImpl ?? triageInboxContent,
    gate: deps.gateImpl ?? gateTopicCandidate,
    patterns: deps.patternStore ?? { upsert: upsertPatternCard, findByCanonicalUrl: findPatternByCanonicalUrl },
    loadProfile: deps.loadProfileImpl ?? loadProfile,
  };
  const sendReceipt = deps.sendReceiptImpl ?? sendTelegramReceipt;
  const report = deps.onError ?? ((m: string) => console.error(`[inbox-digest] ${m}`));

  /** 回执与它的落账都不许影响消化结果（§2.1）——失败只留痕 */
  async function deliverReceipt(item: InboxItem, text: string): Promise<void> {
    if (item.source !== "telegram" || item.chatId === undefined || !deps.telegram) return;
    let sent = false;
    try {
      sent = await sendReceipt(item.chatId, text, deps.telegram);
    } catch (err) {
      report(`回执发送抛错（${item.id}）：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!sent) report(`回执未送达（${item.id}），已标记 receiptStatus=failed`);
    try {
      await updateItem(item.id, { receiptStatus: sent ? "sent" : "failed" }, ctx.dataDir);
    } catch (err) {
      report(`回执状态写台账失败（${item.id}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return async function processItem(item: InboxItem): Promise<ProcessResult> {
    const progress: Progress = { stage: item.stage, targetIds: [...(item.targetIds ?? [])], landings: [] };
    let outcome: Outcome;
    try {
      if (item.text) outcome = await digestText(ctx, item, progress);
      else if (item.url) outcome = await digestUrl(ctx, item, progress);
      else outcome = rejectedOutcome(DIGEST_RECEIPTS.emptyItem, "empty_item", progress);
    } catch (err) {
      outcome = failureOutcome(err, progress, item.attempts);
    }
    await deliverReceipt(item, outcome.receipt);
    // 判定已落定；台账的终态由 worker 紧随其后写入（C2 的消费方按 itemId 重读）
    deps.onEvent?.({ type: "inbox:updated", itemId: item.id });
    return outcome.result;
  };
}
