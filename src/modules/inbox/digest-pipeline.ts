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
 *    可重试故障 → failed。映射表与全部回执文案在 `digest-outcome.ts`，是验收项，不许随手改。
 * 2. **断点续做**：`both` 的卡步做完就把 stage=card_done 随结果（含失败结果）带回，
 *    重试时跳过卡步；卡本身也按 sourceInboxId 幂等，重跑不会产生第二张。
 * 3. **回执是旁路**：发失败只标 receiptStatus=failed，绝不回滚消化结果（§2.1）。
 *
 * 域名路由（§3.2）：抖音（douyin.com / v.douyin.com / iesdouyin.com）走 justoneapi 专用
 * 解析器——V1.1 起生效，缺 key 落 blocked 并指引去设置页（保存即自动唤醒）。x.com 仍**不特判**：
 * tweet-by-id 解析器是下一期，在它上线前走通用抓取，抓不到正文按判定落 rejected/failed。
 */
import { loadProfile, type CreatorProfile } from "../profile/creator-profile.js";
import {
  findPatternByCanonicalUrl,
  upsertPatternCard,
  type PatternCard,
  type PatternCardInput,
  type PatternStats,
} from "../patterns/pattern-store.js";
import { gateTopicCandidate, type GateResult, type TopicCandidate } from "../radar/intake-gate.js";
import {
  carry,
  DIGEST_RECEIPTS,
  duplicateOutcome,
  failureOutcome,
  rejectedOutcome,
  type Outcome,
  type Progress,
} from "./digest-outcome.js";
import { fetchExternalPage, type ExternalPage } from "./fetch-external.js";
import {
  createJustoneapiClient,
  douyinCanonicalUrl,
  extractDouyinVideoId,
  isDouyinShareLink,
  isDouyinUrl,
  JustoneapiError,
  type DouyinVideoContent,
  type JustoneapiClient,
} from "./justoneapi.js";
import { findByCanonicalUrl, findByTextHash, updateItem, type InboxItem } from "./inbox-store.js";
import { type ProcessResult } from "./inbox-worker.js";
import { sendTelegramReceipt, type TelegramClientOptions } from "./telegram-api.js";
import {
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

/** 按域名路由的专用解析器配置（§3.2）。key 缺省 = 该域名的链接落 blocked，不静默降级去通用抓取 */
export interface DigestParserDeps {
  justoneapiKey?: string;
  /** 测试注入；仍受 key 门约束——「有没有配」与「怎么调」是两件事 */
  justoneapiImpl?: JustoneapiClient;
}

export interface DigestPipelineDeps {
  /** 固定工作区（§2.1 targetWorkspaceId） */
  dataDir: string;
  telegram?: DigestTelegramConfig;
  parsers?: DigestParserDeps;
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

// ─── 内部形态 ────────────────────────────────────────────────────────────────

interface Ctx {
  dataDir: string;
  fetchPage: NonNullable<DigestPipelineDeps["fetchImpl"]>;
  triage: NonNullable<DigestPipelineDeps["triageImpl"]>;
  gate: NonNullable<DigestPipelineDeps["gateImpl"]>;
  patterns: DigestPatternStore;
  loadProfile: NonNullable<DigestPipelineDeps["loadProfileImpl"]>;
  /** 缺 key 时抛 blocked 态的 JustoneapiError——由 classifyError 统一落账与回执 */
  douyin: () => JustoneapiClient;
}

/**
 * 解析器直接产出、**不经 LLM** 的卡片字段（§3.2）：数据是抓取时点的事实，
 * 让模型转述一遍只会引入幻觉。
 */
interface ParsedExtras {
  author?: string;
  stats?: PatternStats;
}

/** 由正文派生标题时的字数（随手记取前 30 字、抖音取文案首行 30 字；按码点切，别劈开代理对） */
const TEXT_TITLE_CHARS = 30;
/** 备注里带这两个词 = 创始人显式要求重拆，绕开全部查重（§3.5 显式覆盖） */
const REDO_RE = /重拆|redo/i;

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

/**
 * 幂等键落账 + 三库查重——两条链接路径（通用抓取 / 抖音解析器）的共用中段。
 * 返回非空 = 这条是重复件，直接拿它当结论。
 */
async function claimCanonical(ctx: Ctx, item: InboxItem, canonicalUrl: string): Promise<Outcome | null> {
  // 幂等键先落账：崩在分流途中，重跑也认得这条是谁（§3.1）
  if (item.canonicalUrl !== canonicalUrl) await updateItem(item.id, { canonicalUrl }, ctx.dataDir);
  if (wantsRedo(item.note)) return null;
  return findDuplicate(ctx, item, canonicalUrl);
}

/** 域名路由（§3.2）：抖音走专用解析器，其余（含 x.com，解析器下一期）走通用抓取 */
async function digestUrl(ctx: Ctx, item: InboxItem, progress: Progress): Promise<Outcome> {
  const sourceUrl = item.url ?? "";
  if (isDouyinUrl(sourceUrl)) return digestDouyin(ctx, item, sourceUrl, progress);

  const page = await ctx.fetchPage(sourceUrl);
  const canonicalUrl = canonicalizeUrl(page.finalUrl);
  const duplicate = await claimCanonical(ctx, item, canonicalUrl);
  if (duplicate) return duplicate;

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
  return routeVerdict(ctx, item, canonicalUrl, triaged, progress, {});
}

// ─── 抖音：justoneapi 解析器（§3.2，V1.1） ──────────────────────────────────

function fmtDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/**
 * 分流输入正文：文案 + 空行 + 「作者 ｜ 发布 ｜ 时长」+「数据：赞评藏转」。
 * 缺的字段整段省略，不写「未知」——给模型一堆占位词只会让它编。
 */
function douyinTriageText(video: DouyinVideoContent): string {
  const { likes, comments, collects, shares } = video.stats;
  const keep = (v: string | null): v is string => v !== null;
  const meta = [
    video.authorNickname ? `作者：${video.authorNickname}` : null,
    video.createTime !== undefined ? `发布：${new Date(video.createTime * 1000).toISOString().slice(0, 10)}` : null,
    video.durationMs !== undefined ? `时长：${fmtDuration(video.durationMs)}` : null,
  ].filter(keep);
  const numbers = [
    likes !== undefined ? `赞${likes}` : null,
    comments !== undefined ? `评${comments}` : null,
    collects !== undefined ? `藏${collects}` : null,
    shares !== undefined ? `转${shares}` : null,
  ].filter(keep);
  const tail = [meta.join(" ｜ "), numbers.length ? `数据：${numbers.join(" ")}` : ""].filter(Boolean);
  return [video.desc.trim(), ...(tail.length ? ["", ...tail] : [])].join("\n");
}

/**
 * 判定顺序（改这里等于改验收语义）：
 * key 门（缺 → blocked）→ 短链换标准链 → videoId → 幂等键 + 三库查重 → 取详情 → 分流。
 * 查重排在取详情**之前**：重复件不该再烧一次 API 额度。
 */
async function digestDouyin(
  ctx: Ctx,
  item: InboxItem,
  sourceUrl: string,
  progress: Progress,
): Promise<Outcome> {
  const client = ctx.douyin(); // 缺 key 在这里抛 blocked 态的 JustoneapiError
  const standardUrl = isDouyinShareLink(sourceUrl) ? await client.resolveShareUrl(sourceUrl) : sourceUrl;
  const videoId = extractDouyinVideoId(standardUrl);
  if (!videoId) return rejectedOutcome(DIGEST_RECEIPTS.douyinNoVideoId, "douyin_no_video_id", progress);

  const canonicalUrl = douyinCanonicalUrl(videoId);
  const duplicate = await claimCanonical(ctx, item, canonicalUrl);
  if (duplicate) return duplicate;

  const video = await client.fetchVideoDetail(videoId);
  const profile = await ctx.loadProfile(ctx.dataDir);
  const triaged = await ctx.triage(
    {
      content: {
        text: douyinTriageText(video),
        title: clampChars(video.desc.split("\n")[0] ?? "", TEXT_TITLE_CHARS),
        sourceUrl,
        finalUrl: video.canonicalUrl,
      },
      ...(item.note ? { note: item.note } : {}),
      profile,
    },
    { dataDir: ctx.dataDir },
  );
  return routeVerdict(ctx, item, canonicalUrl, triaged, progress, {
    ...(video.authorNickname ? { author: video.authorNickname } : {}),
    stats: { ...video.stats, capturedAt: new Date().toISOString() },
  });
}

/** 卡步：stage=card_done 就跳过（续做）；落卡按 sourceInboxId 幂等，重跑不产生第二张 */
async function runCardStep(
  ctx: Ctx,
  item: InboxItem,
  canonicalUrl: string,
  triaged: TriageResult,
  progress: Progress,
  extras: ParsedExtras,
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
      // 解析器产出的事实字段：不经 LLM 直接落卡（§3.2）
      ...(extras.author ? { author: extras.author } : {}),
      ...(extras.stats ? { stats: extras.stats } : {}),
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
  extras: ParsedExtras,
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
    await runCardStep(ctx, item, canonicalUrl, triaged, progress, extras);
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
    douyin: () => {
      // key 门先过：没配就是「等外部条件」，不能悄悄降级成通用抓取（抖音页反爬，抓了也是空）
      const key = deps.parsers?.justoneapiKey?.trim();
      if (!key) {
        throw new JustoneapiError(
          "justoneapi_key_missing",
          "blocked",
          "抖音链接要 justoneapi key 才能解析，现在还没配",
        );
      }
      return deps.parsers?.justoneapiImpl ?? createJustoneapiClient(key);
    },
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
