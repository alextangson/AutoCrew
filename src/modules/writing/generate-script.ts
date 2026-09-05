/**
 * 生成管线 — 进程内口播脚本生成（PRD §5 内层 loop）
 *
 * 流程：loadEngineConfig + getPack + loadProfile → buildScriptPrompts
 *   → runLoop（submit_script 工具作为结构化输出通道）
 *   → 组装 + humanizeZh → AI 审稿（含修订轮，script-review）
 *   → scanText（违禁词）→ saveContent（draft_ready）
 *
 * submit_script 工具的 execute 闭包捕获 payload；缺字段时返回错误消息让
 * 模型自纠，而不是抛出（保持 loop 继续）。
 * 组装 + humanizeZh 只做一次（审稿 spec §2.1：审稿必须看到终稿形态），
 * 审稿产出直接进转正——同一段文本不许算两遍。
 */
import { hostOf, loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { classifyEngineError } from "../../engine/error-kind.js";
import { describeEngineFailure, isEngineFailure } from "../../engine/failure-text.js";
import { cleanErrorMessage } from "../../desktop/error-clean.js";
import type { EngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopFallbackInfo, LoopResult, LoopTool } from "../../engine/loop.js";
import { getPack, getPackForPlatform } from "../packs/index.js";
import type { QualityGateSpec } from "../packs/pack-schema.js";
import { loadProfile } from "../profile/creator-profile.js";
import { recentContrastPairs } from "../learnings/diff-tracker.js";
import { buildScriptPrompts } from "./script-prompt.js";
import type { ResolvedAngle, ScriptRequest } from "./script-prompt.js";
import { selectPatternsForScript } from "../patterns/pattern-select.js";
import type { PatternCard } from "../patterns/pattern-store.js";
import { resolveQualityGate } from "./quality-gate.js";
import type { GateFailure } from "./quality-gate.js";
import {
  assembleAndHumanize,
  buildSubmitTool,
  createCapture,
  isAcceptedCapture,
  DEFAULT_REPAIR_ROUNDS, WRITER_MAX_TOKENS } from "./script-payload.js";
import type { CaptureBlock, Captured, SubmitGateDeps, SubmitPayload } from "./script-payload.js";
import {
  assembleResearchInput,
  joinCoreEvidence,
  renderCoreEvidence,
  ANCHOR_BUDGET,
  VOICE_REFERENCE_BUDGET,
  type ResearchSnapshot,
} from "./input-budget.js";
import { reviewAndConverge } from "./script-review.js";
import type { ReviewDeps, ReviewMeta, ReviewOutcome } from "./script-review.js";
import { transitionStatus } from "../../storage/local-store.js";
import { scanText } from "../filter/sensitive-words.js";
import { retrieveKnowledge, KNOWLEDGE_DEFAULT_CHARS } from "../knowledge/knowledge-base.js";
import { buildBriefBlock } from "../research/brief-inject.js";
import { resolveEffectiveBrief, type BriefSnapshot } from "../research/brief-snapshot.js";
import { activeAngleCard, angleCardHash, angleCardsOf } from "../research/angle-cards.js";
import { evidenceByRef, isAngleCardV3, type AngleCardV3 } from "../research/brief-store.js";
import {
  createEvidenceLedger,
  seedLedgerFromBrief,
  seedLedgerFromOwnMaterial,
  seedLedgerFromUserClaims,
  type EvidenceLedger,
} from "../research/evidence-ledger.js";
import {
  collectOwnMaterial,
  renderOwnMaterial,
  ownChunkById,
  EMPTY_OWN_MATERIAL,
  type OwnMaterial,
  type OwnMaterialChunk,
  type OwnMaterialRef,
} from "../research/own-material.js";
import {
  buildFindEvidenceTool,
  createTargetedResearcher,
  renderTargetedEvidence,
  researchNeeds,
  type TargetedResearcher,
} from "../research/targeted-research.js";
import { searchAvailable } from "../research/search-provider.js";
import { topicHashOf } from "../research/research-job-store.js";
import { getContent, getDataDir, getTopic, saveContent, updateContent } from "../../storage/local-store.js";
import type { Content, Topic } from "../../storage/local-store.js";
import { rulesForPlatform } from "../profile/creator-profile.js";

export type { ScriptRequest };

export interface GeneratedScript {
  contentId: string;
  title: string;
  /** hook + 正文 + CTA 组装后、humanize 后的最终文本 */
  body: string;
  hashtags: string[];
  /** 违禁词命中（不阻断存稿，透出给上层） */
  violations: string[];
  /** Quality Gate 未过项（空 = 全过或包无 gate）；修复轮耗尽后的残余 FAIL 透出，不静默 */
  gateFailures: string[];
  /** 本稿注入的个人写作规则数（声音内核+当前平台包——IA v4.2 §B5「越用越像你」可感知） */
  rulesApplied: number;
  /**
   * 这稿是在**没有调研简报**的情况下写出来的（调研闸口跑不了/失败/等超时）。
   * 只对带 topicId 的选题写作有意义：带上了简报、或压根不是从选题开写，都是 false。
   */
  wroteWithoutBrief: boolean;
  /**
   * 这条选题**有**角度候选卡，但这稿绕过了点选（角度卡 spec §1.6）。
   * 没有候选卡、或用了手写 direction 都是 false——那两种情况下没有闸口可绕。
   */
  wroteWithoutAngle: boolean;
  /** AI 审稿结论（审稿 spec §2.5）：降级路径也一定有值——skipped/failed 就是「没审成」的留痕 */
  review: ReviewMeta;
  /**
   * 硬门拦下了这一稿（P1 §4.4）：稿件落到 `needs_evidence` 而不是 `draft_ready`。
   * 正文照样存盘（创始人要能看见被拦的是什么），但它不是成稿。
   */
  needsEvidence: boolean;
  /** 被拦的人话原因（硬门打回文案）；没被拦时缺席 */
  blockedReason?: string;
  /** 无据数字 + 归一不了的模糊量词——看板与编辑器据此列清单 */
  unverifiedNumbers: string[];
  tokensUsed: number;
}

/**
 * 开写前「补一轮深调研」的结果（适配器在 desktop 层实现，见 write-research-gate）。
 * 五态里三态都是降级——降级必须带人话 note，写稿侧照写但要留痕。
 */
export type EnsureBriefOutcome =
  | { state: "already" }
  | { state: "ready" }
  | { state: "unavailable"; note: string }
  | { state: "failed"; note: string }
  | { state: "timeout" };

/** 生成管线的注入口：loop 替身（测试用）+ 非致命故障的可见出口 */
export interface GenerationDeps {
  runLoopImpl?: typeof runLoop;
  /**
   * 「材料少一块但照写」这类降级的可见出口（简报读不动、选题查不到）；默认 console.warn。
   * 静默降级会让「简报怎么没生效」查无可查。
   */
  onWarn?: (message: string) => void;
  /**
   * 写作入口的调研闸口：带 topicId 开写且该选题还没有简报时，先补一轮深调研再写。
   * 不注入 = 老行为（有简报就注入，没有就裸写），桌面 IPC 与 chat-router 两条入口注入。
   * MCP 同步入口（src/tools）**故意不接**：外部 agent 自己有 deep_research 工具与判断力，
   * 这层不该替它决定「该不该先调研」，更不该让它在一个同步调用里干等十几分钟。
   *
   * `onWaiting`：闸口**确定要等**（触发被接受、开始轮询前）时回调一次，写作侧借此把
   * 占位稿标题改成「调研中」。已有简报/跑不了时不调——那两条路径根本没有等待。
   */
  ensureBriefImpl?: (topicId: string, onWaiting?: () => Promise<void>) => Promise<EnsureBriefOutcome>;
  /**
   * 整稿墙钟（P1 §4.4，缺省 15 分钟）。生产不传；测试与运维压缩它来验「到点即中断」。
   * 到点不是「等久一点」，是这一轮作废——占位稿标〔生成中断〕，重试从头再来一次。
   */
  wallClockMs?: number;
}

/** 本稿的归因元数据——两条落点（run-log 的 logMeta 与 content 元数据）共用同一份 */
interface Attribution {
  usedPatternIds: string[];
  /** 本稿注入的简报版本（§6）：无简报时字段不出现，日志与稿件口径与改动前一字不差 */
  usedBriefRevision?: number;
  /** 同一份快照的内容指纹（P1 §3.0）：版本号说「哪一版」，指纹说「盘上那份没被换过」 */
  usedBriefHash?: string;
  /** 本稿生效的角度卡（P1 §4.4）：id + 卡版本 + 内容指纹，三样缺一说不清「写的是哪一版」 */
  usedAngle?: { id: string; cardVersion: number; hash: string };
  /** 写手实际注入的内部语料片段（§3.2）：与简报里的 `ownMaterialRefs`（立意侧）分记 */
  usedOwnMaterial?: OwnMaterialRef[];
  /** 定向补证登记进账本的条目 id（§3.3） */
  usedLookupIds?: string[];
  /** 用户明说跳过角度点选的原话（§1.6）：进结构化 run-log，不只是一句 warn */
  angleSkipReason?: string;
}

/**
 * 整稿墙钟（P1 §4.4）：补证 + 写稿 + 审稿三段合计的上限。
 * 35 分钟：DeepSeek 上补证 ≤6 分钟、写稿 5–8 分钟、审稿段 ≤16 分钟；原 15 分钟会在审稿段中途砍掉。
 */
export const GENERATION_WALL_CLOCK_MS = 35 * 60_000;

/** 生成占位稿标题哨兵——区分「生成占位稿」与手工存的 drafting 稿(content-save 允许)。
 *  renderer(board/workbench.js)按同字面量正则识别,改动需同步。 */
export const GENERATING_TITLE_PREFIX = "［生成中］";
export const INTERRUPTED_TITLE_PREFIX = "［生成中断］";
/**
 * 开写前等深调研简报的中间态（最长十几分钟）。占位稿在这段时间里说实话:
 * 「调研中」不是「生成中」——不然人看到的是一张十分钟不动的卡,和卡死没有区别。
 * **消费方必须同步**:orphan-reconcile 的孤儿判定、Editor.tsx 的剥前缀正则,
 * 漏一处就是启动扫不到的尸体稿 / 重写时把前缀当选题带进去。
 */
export const RESEARCHING_TITLE_PREFIX = "［调研中］";

/** 占位稿先行（防呆 P1）:分钟级长任务先落盘——中途死不许蒸发,刷新/断连不影响它的存在 */
async function createPlaceholder(req: ScriptRequest, dataDir?: string): Promise<string> {
  const placeholder = await saveContent(
    {
      title: `${GENERATING_TITLE_PREFIX}${req.topic.slice(0, 40)}`,
      body: "",
      platform: req.platform,
      status: "drafting",
      tags: [],
      hashtags: [],
      // 血缘(V5.4c):从占位稿起就带上灵感来源,转正时 updateContent 不触碰该字段
      ...(req.topicId ? { topicId: req.topicId } : {}),
      // 中断重写的依据:写崩之后靠它原样重来一次,不必从标题反推(调研材料会丢)
      genRequest: req,
    },
    dataDir,
  );
  return placeholder.id;
}

/** 占位稿标题上的三个阶段哨兵——重写要的是它们后面那个原选题 */
const TITLE_SENTINELS = [GENERATING_TITLE_PREFIX, RESEARCHING_TITLE_PREFIX, INTERRUPTED_TITLE_PREFIX];

function stripTitleSentinel(title: string): string {
  const hit = TITLE_SENTINELS.find((p) => title.startsWith(p));
  return hit ? title.slice(hit.length) : title;
}

/**
 * 重建中断稿的写作请求。有 genRequest 就照抄（连调研材料、对标卡开关一起）；
 * 旧稿没有这个字段时降级还原——选题只能从标题剥哨兵取回，材料确实找不回来了，
 * 但「在原稿上重写」这件事本身不该因为一份旧数据就做不成。
 */
function rebuildRequest(content: Content): ScriptRequest {
  if (content.genRequest) return content.genRequest;
  if (!content.platform) {
    throw new Error(`稿件 ${content.id} 没有记录目标平台,无法重写——请在编辑器里手工补一篇`);
  }
  return {
    topic: stripTitleSentinel(content.title),
    platform: content.platform as ScriptRequest["platform"],
    ...(content.topicId ? { topicId: content.topicId } : {}),
  };
}

/** 选卡（usePatterns:false 显式关闭时连读都不读）。选题标题与角度都在 req.topic 这一串自由文本里 */
function selectPatterns(req: ScriptRequest, dataDir?: string): Promise<PatternCard[]> {
  if (req.usePatterns === false) return Promise.resolve([]);
  return selectPatternsForScript({ platform: req.platform, topicText: req.topic }, dataDir);
}

interface ResolvedResearch {
  /** 简报快照 + 它相对当前选题是否过期；无 topicId / 无指针 / 文件坏了都缺席。
   *  注入块**不在这里渲染**：要渲染成什么样得先知道选中卡引了哪几条证据（§4.3 去重） */
  brief?: { snapshot: BriefSnapshot; topicStale: boolean };
  /** 本稿生效的角度卡（手写 direction、没选、选择已过期时缺席） */
  angle?: ResolvedAngle;
  /** 这条选题**有**角度候选卡（无论这轮是否用上） */
  hasCards: boolean;
  /** 选题本体（内部语料按它的标题+描述检索）；查不到时缺席 */
  topic?: Topic;
}

/**
 * 简报快照 → 注入块 + 生效角度（深调研 §6 + 角度卡 §1.3 + P1 §3.0）。
 *
 * **一次生成只读一次快照**：注入的事实、选中卡是否还作数、归因写的版本号，三者必须
 * 出自同一份简报。改动前注入认 `job.briefRevision`、角度解析认「磁盘最新版」，重跑刚落盘
 * 而指针未推进的窗口里，会把 v1 的材料配上 v2 的卡写成一稿（P1 spec §3.0）。
 *
 * `resolveEffectiveBrief` 没有指针就返回 null，绝不回落磁盘最新版——重跑失败不推进指针
 * 是设计意图，兜底等于把没被采纳的那版偷偷注进稿子。
 *
 * `hasCards` 是「这条选题本来有角度可选」：它 + 没生效角度 = 这稿绕过了品味闸口，
 * 要在版本注记里说出来（§1.6「直写稿版本注记标未经角度点选」）。
 */
async function resolveResearch(
  req: ScriptRequest,
  dataDir: string | undefined,
  warn: (message: string) => void,
): Promise<ResolvedResearch> {
  if (!req.topicId) return { hasCards: false };
  try {
    const snapshot = await resolveEffectiveBrief(req.topicId, getDataDir(dataDir), warn);
    if (!snapshot) return { hasCards: false };
    const { brief } = snapshot;
    const hasCards = angleCardsOf(brief).length > 0;
    const topic = await getTopic(req.topicId, dataDir);
    if (!topic) warn(`选题 ${req.topicId} 已不在库中，简报按「基于旧版选题」标注注入`);
    const currentHash = topic ? topicHashOf(topic.title, topic.description) : "";
    // 核对不上就当过期：选题查不到时不给这份简报背书（§2 过期标注，注入照做）
    const topicStale = !topic || currentHash !== brief.topicHash;
    const injected = { snapshot, topicStale };
    const found = { ...(topic ? { topic } : {}) };
    // 手写角度压过一切：卡照样算「有」，但这一轮不解析它（§1.3 手填时角度卡仍展示不注入）
    if (req.direction?.trim()) return { brief: injected, hasCards, ...found };
    // 「选中」现算是否还作数：选的不是快照那版、或简报因选题被改而过期，一律按没选处理
    const card = activeAngleCard(topic?.selectedAngle, brief, currentHash);
    if (!card) {
      if (topic?.selectedAngle) {
        warn(`选中的角度已过期（选题或简报在选完之后变过），本稿按未选角度写：${req.topicId}`);
      }
      return { brief: injected, hasCards, ...found };
    }
    return {
      brief: injected,
      angle: { card, evidence: brief.evidence, tensions: brief.tensions },
      hasCards,
      ...found,
    };
  } catch (err) {
    // 材料少一块照写，绝不让读盘故障带走整条写作链
    const msg = err instanceof Error ? err.message : String(err);
    warn(`调研简报读取失败（${req.topicId}），本稿按无简报无角度写：${msg}`);
    return { hasCards: false };
  }
}

/** 生效卡里的 v3；v2 卡与手写 direction 都返回 undefined（v3 才有补证与新角度块） */
function activeV3(angle?: ResolvedAngle): AngleCardV3 | undefined {
  const card = angle?.card;
  return card && isAngleCardV3(card) ? card : undefined;
}

/** 一稿的内部语料只有**一处**能当亲历案例用：卡上 firsthandAnchor 指的那一段（§3.2 注入规则） */
function splitOwnMaterial(
  material: OwnMaterial,
  angle?: ResolvedAngle,
): { anchor: OwnMaterialChunk | null; rest: OwnMaterialChunk[] } {
  const anchorId = activeV3(angle)?.firsthandAnchor?.chunkId;
  const anchor = anchorId ? ownChunkById(material, anchorId) : null;
  return { anchor, rest: material.chunks.filter((c) => c !== anchor) };
}

/** 块头留出的余量：`renderOwnMaterial` 只管块体，标题行的开销要从预算里先扣掉，
 *  否则装配层的硬截断会切在结束定界符上——半个块等于把外部文本泄进指令区 */
const BLOCK_HEADING_ROOM = 80;

function renderAnchorBlock(anchor: OwnMaterialChunk | null): string {
  if (!anchor) return "";
  return [
    "【第一手锚点（本稿唯一可以当亲身经历讲的材料）】",
    renderOwnMaterial([anchor], ANCHOR_BUDGET - BLOCK_HEADING_ROOM),
  ].join("\n");
}

function renderVoiceBlock(rest: OwnMaterialChunk[]): string {
  if (rest.length === 0) return "";
  return [
    "【口吻参考（只学他怎么说话，不得当案例讲，也不要说成「我做过」）】",
    renderOwnMaterial(rest, VOICE_REFERENCE_BUDGET - BLOCK_HEADING_ROOM),
  ].join("\n");
}

/** 内部语料只在带 topicId 时收：`collectOwnMaterial` 的同选题泄漏防线靠 topicId 认，没有它就形同虚设 */
async function gatherOwnMaterial(
  req: ScriptRequest,
  topic: Topic | undefined,
  dataDir: string | undefined,
  warn: (message: string) => void,
): Promise<OwnMaterial> {
  if (!req.topicId) return EMPTY_OWN_MATERIAL;
  try {
    return await collectOwnMaterial(getDataDir(dataDir), {
      id: req.topicId,
      title: topic?.title ?? req.topic,
      ...(topic?.description ? { description: topic.description } : {}),
    });
  } catch (err) {
    // 语料是加分项：扫盘故障不该带走整条写作链
    warn(`内部语料读取失败（${req.topicId}）：${err instanceof Error ? err.message : String(err)}——本稿按无语料写`);
    return EMPTY_OWN_MATERIAL;
  }
}

/**
 * 一稿一本账（§3.3）：简报证据、内部语料、用户材料先全部登记，拿到稳定 id，
 * 正文里的每个数字最后都要能指回其中一条。
 */
function seedLedger(
  req: ScriptRequest,
  picked: ResolvedResearch,
  ownMaterial: OwnMaterial,
): EvidenceLedger {
  const ledger = createEvidenceLedger();
  if (picked.brief) seedLedgerFromBrief(ledger, picked.brief.snapshot.brief);
  seedLedgerFromOwnMaterial(ledger, ownMaterial.chunks);
  seedLedgerFromUserClaims(ledger, [
    ...(req.research?.trim() ? [{ id: "user-research", text: req.research }] : []),
    ...(picked.topic?.description?.trim() ? [{ id: "user-topic", text: picked.topic.description }] : []),
  ]);
  return ledger;
}

/** 补证阶段的产物：写手的查证工具从这个 researcher 上挂，降级留痕进版本注记 */
interface EvidencePhase {
  researcher?: TargetedResearcher;
  /** 降级人话（未补证 / 补证失败）；正常路径缺席 */
  note?: string;
}

/**
 * 定向补证（§4.2 调用点）。只有**选中的 v3 卡**才补：手写 direction 是创始人自己定的角度、
 * 明说跳过点选的没有卡、v2 卡没有 `evidenceNeeds`——三种情况下没有「这个主张缺什么证据」
 * 这个问题可问，跑一轮搜索只是烧钱。
 *
 * 搜索没配 → warn + 跳过 + 版本注记「未补证」（§5）。补证失败**永不抛**：少一块材料照写，
 * 写手会在增补证据块里看到「没找到」，那比让它以为材料齐全安全。
 */
async function runEvidencePhase(args: {
  req: ScriptRequest;
  angle?: ResolvedAngle;
  config: EngineConfig;
  ledger: EvidenceLedger;
  dataDir?: string;
  warn: (message: string) => void;
  runLoopImpl?: typeof runLoop;
}): Promise<EvidencePhase> {
  const { req, config, ledger, dataDir, warn } = args;
  const card = activeV3(args.angle);
  const wantsLookup =
    !!card && card.evidenceNeeds.length > 0 && !req.direction?.trim() && !req.angleSkipReason?.trim();

  const canSearch = await searchAvailable(dataDir).catch(() => false);
  if (!canSearch) {
    if (wantsLookup) warn("搜索未配置：本稿跳过定向补证，写手只能用现有材料（版本注记标「未补证」）");
    return wantsLookup ? { note: "未补证" } : {};
  }
  const researcher = createTargetedResearcher({
    dataDir: getDataDir(dataDir),
    config,
    ledger,
    ...(args.runLoopImpl ? { runLoopImpl: args.runLoopImpl } : {}),
  });
  if (!wantsLookup) return { researcher };
  try {
    await researchNeeds(researcher, card.evidenceNeeds);
  } catch (err) {
    warn(`定向补证失败（不阻断写稿）：${err instanceof Error ? err.message : String(err)}`);
    return { researcher, note: "补证失败" };
  }
  return { researcher };
}

interface GenerationInputs {
  config: EngineConfig;
  pack: ReturnType<typeof getPack>;
  profile: Awaited<ReturnType<typeof loadProfile>>;
  contrastPairs: Awaited<ReturnType<typeof recentContrastPairs>>;
  patterns: PatternCard[];
  /** research 槽装配完的请求（快照文本写进 `research`） */
  promptReq: ScriptRequest;
  /** 写手与审稿共用的**同一份**材料快照（§4.3：两侧不许各裁一刀） */
  snapshot: ResearchSnapshot;
  /** 本稿生效的角度卡；手写 direction 或没选时缺席（direction 由 buildUserPrompt 自己认） */
  angle?: ResolvedAngle;
  /** 有候选卡却没有生效角度 = 绕过了品味闸口，版本注记要说出来 */
  wroteWithoutAngle: boolean;
  attribution: Attribution;
  /** 一稿一本账：写手与修订轮共享同一个实例（含 find_evidence 的次数额度） */
  ledger: EvidenceLedger;
  /** 有它才给写手挂 find_evidence（搜索没配时就是没有） */
  researcher?: TargetedResearcher;
  /** 补证降级的人话，进版本注记 */
  evidenceNote?: string;
}

/**
 * research 槽装配（§4.3 优先级表）。顺序是**预算表定的**，不是 join 的先后：
 * 核心证据与补证块占第一档（本稿主张的地基），简报去掉已在第一档的证据，
 * 内部语料锚点、用户材料、口吻参考依次占位，知识库拿剩余（<400 整块省略）。
 */
async function composeResearchSlot(
  req: ScriptRequest,
  picked: ResolvedResearch,
  ledger: EvidenceLedger,
  ownMaterial: OwnMaterial,
  dataDir?: string,
): Promise<ResearchSnapshot> {
  const card = activeV3(picked.angle);
  const coreIds = card?.coreEvidenceIds ?? [];
  const evidence = picked.brief?.snapshot.brief.evidence ?? [];
  const coreEvidence = joinCoreEvidence(
    renderCoreEvidence(
      coreIds
        .map((id) => ({ id, item: evidenceByRef(evidence, id) }))
        .filter((e): e is { id: string; item: NonNullable<typeof e.item> } => e.item !== null)
        .map(({ id, item }) => ({
          id,
          ...(item.claim ? { claim: item.claim } : {}),
          quote: item.quote,
          ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
        })),
    ),
    renderTargetedEvidence(ledger),
  );
  const brief = picked.brief
    ? buildBriefBlock(picked.brief.snapshot.brief, {
        topicStale: picked.brief.topicStale,
        excludeEvidenceIds: coreIds,
      })
    : "";
  const { anchor, rest } = splitOwnMaterial(ownMaterial, picked.angle);

  return assembleResearchInput(
    {
      coreEvidence,
      brief,
      ownAnchor: renderAnchorBlock(anchor),
      ...(req.research ? { userResearch: req.research } : {}),
      voiceReference: renderVoiceBlock(rest),
    },
    {
      defaultChars: KNOWLEDGE_DEFAULT_CHARS,
      retrieve: (maxChars) => retrieveKnowledge(req.topic, dataDir, { maxChars }),
    },
  );
}

/** 写稿前的材料收集：能并行的一起拿，补证与装配必须等简报/卡落定才能跑 */
async function gatherInputs(
  req: ScriptRequest,
  dataDir: string | undefined,
  warn: (message: string) => void,
  deps?: GenerationDeps,
): Promise<GenerationInputs> {
  const [config, pack, profile, contrastPairs, patterns, picked] = await Promise.all([
    loadEngineConfig(dataDir),
    Promise.resolve(req.packId ? getPack(req.packId) : getPackForPlatform(req.platform)),
    loadProfile(dataDir),
    // 改稿对比对(V5.7 活人感):读取失败不阻断写稿——样例是增强,不是依赖
    recentContrastPairs(3, dataDir).catch(() => []),
    // 对标拆解卡(收件箱 §3.5):平台+主题相关才选,无匹配即空数组。
    // 这里**不加 catch**:patterns 库不存在是正常空态(store 已按 ENOENT 返回 []),
    // 其余读故障必须炸出来——静默降级会让「卡怎么没生效」查无可查。
    selectPatterns(req, dataDir),
    // 调研简报 + 角度卡(深调研 §6 / 角度卡 §1.3):同一份快照解析,三条写稿入口一次覆盖
    resolveResearch(req, dataDir, warn),
  ]);

  const ownMaterial = await gatherOwnMaterial(req, picked.topic, dataDir, warn);
  const ledger = seedLedger(req, picked, ownMaterial);
  const phase = await runEvidencePhase({
    req,
    ...(picked.angle ? { angle: picked.angle } : {}),
    config,
    ledger,
    dataDir,
    warn,
    ...(deps?.runLoopImpl ? { runLoopImpl: deps.runLoopImpl } : {}),
  });
  const snapshot = await composeResearchSlot(req, picked, ledger, ownMaterial, dataDir);
  const { anchor, rest } = splitOwnMaterial(ownMaterial, picked.angle);
  const injectedChunks = [...(anchor ? [anchor] : []), ...rest];
  const lookupIds = ledger.lookups().flatMap((l) => l.itemIds);

  return {
    config,
    pack,
    profile,
    contrastPairs,
    patterns,
    promptReq: snapshot.text ? { ...req, research: snapshot.text } : req,
    snapshot,
    ...(picked.angle ? { angle: picked.angle } : {}),
    wroteWithoutAngle: picked.hasCards && !picked.angle && !req.direction?.trim(),
    ledger,
    ...(phase.researcher ? { researcher: phase.researcher } : {}),
    ...(phase.note ? { evidenceNote: phase.note } : {}),
    attribution: {
      usedPatternIds: patterns.map((card) => card.id),
      ...(picked.brief
        ? {
            usedBriefRevision: picked.brief.snapshot.revision,
            usedBriefHash: picked.brief.snapshot.hash,
          }
        : {}),
      ...(picked.angle
        ? {
            usedAngle: {
              id: picked.angle.card.id,
              cardVersion: isAngleCardV3(picked.angle.card) ? 3 : 2,
              hash: angleCardHash(picked.angle.card),
            },
          }
        : {}),
      ...(injectedChunks.length > 0
        ? { usedOwnMaterial: injectedChunks.map((c) => ({ id: c.id, excerptHash: c.excerptHash })) }
        : {}),
      ...(lookupIds.length > 0 ? { usedLookupIds: lookupIds } : {}),
      ...(req.angleSkipReason?.trim() ? { angleSkipReason: req.angleSkipReason.trim() } : {}),
    },
  };
}

/** run-log 的归因段（写稿轮与修订轮共用同一份口径）：没用到的字段一律不出现 */
function logAttribution(attribution: Attribution): Record<string, unknown> {
  return {
    ...(attribution.usedPatternIds.length > 0 ? { usedPatternIds: attribution.usedPatternIds } : {}),
    ...(attribution.usedBriefRevision !== undefined ? { usedBriefRevision: attribution.usedBriefRevision } : {}),
    ...(attribution.usedBriefHash ? { usedBriefHash: attribution.usedBriefHash } : {}),
    ...(attribution.usedAngle
      ? {
          usedAngleId: attribution.usedAngle.id,
          usedAngleCardVersion: attribution.usedAngle.cardVersion,
          usedAngleHash: attribution.usedAngle.hash,
        }
      : {}),
    ...(attribution.usedOwnMaterial?.length
      ? { usedOwnMaterialIds: attribution.usedOwnMaterial.map((r) => r.id) }
      : {}),
    ...(attribution.usedLookupIds?.length ? { usedLookupIds: attribution.usedLookupIds } : {}),
    ...(attribution.angleSkipReason ? { angleSkipReason: attribution.angleSkipReason } : {}),
  };
}

/** 归因落稿件元数据（写手开工前一次、收尾一次——中途崩了也不丢） */
function contentAttribution(attribution: Attribution, ledger: EvidenceLedger): Partial<Content> {
  return {
    evidenceLedger: ledger.snapshot(),
    ...(attribution.usedPatternIds.length > 0 ? { usedPatternIds: attribution.usedPatternIds } : {}),
    ...(attribution.usedBriefRevision !== undefined ? { usedBriefRevision: attribution.usedBriefRevision } : {}),
    ...(attribution.usedBriefHash ? { usedBriefHash: attribution.usedBriefHash } : {}),
    ...(attribution.usedAngle ? { usedAngle: attribution.usedAngle } : {}),
    ...(attribution.usedOwnMaterial?.length ? { usedOwnMaterial: attribution.usedOwnMaterial } : {}),
  };
}

/**
 * 占位稿改哨兵前缀。标题是观感不是正确性：写失败只 warn,绝不阻断写作。
 * 顺带给版本注记写人话——updateContent 逢标题变化必记一版,不写注记就是两条「第 N 版」谜语。
 */
async function retitlePlaceholder(
  placeholderId: string,
  phase: "researching" | "writing",
  req: ScriptRequest,
  warn: (message: string) => void,
  dataDir?: string,
): Promise<void> {
  const researching = phase === "researching";
  const prefix = researching ? RESEARCHING_TITLE_PREFIX : GENERATING_TITLE_PREFIX;
  try {
    await updateContent(
      placeholderId,
      {
        title: `${prefix}${req.topic.slice(0, 40)}`,
        _versionNote: researching ? "开写前先补一轮深调研" : "调研落定,开始写稿",
      },
      dataDir,
    );
  } catch (err) {
    warn(`占位稿标题更新失败（${placeholderId}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 开写前补调研（写作入口自动补深调研）。返回 true = 这稿没等到简报，得留痕。
 *
 * 用户自己带了 research 材料时**不强等**：他手里已经有料，为一轮分钟级的调研让他排队，
 * 是拿他的时间换一个他没要的东西。
 *
 * 真等起来时占位稿标题走一个来回：［调研中］→（闸口返回）→［生成中］。改回来这一步不能省，
 * 后面就是写稿阶段了，标题停在「调研中」既骗人，也让中断/孤儿回收的哨兵停在错的那一个。
 */
async function ensureBriefBeforeWriting(
  req: ScriptRequest,
  deps: GenerationDeps | undefined,
  warn: (message: string) => void,
  placeholderId: string,
  dataDir?: string,
): Promise<boolean> {
  if (!req.topicId || !deps?.ensureBriefImpl || req.research?.trim()) return false;
  let waited = false;
  const onWaiting = async (): Promise<void> => {
    waited = true;
    await retitlePlaceholder(placeholderId, "researching", req, warn, dataDir);
  };
  let outcome: EnsureBriefOutcome;
  try {
    outcome = await deps.ensureBriefImpl(req.topicId, onWaiting);
  } catch (err) {
    // 契约上闸口永不抛;执行层不赌上游守约——闸口自己炸了也只是「没简报」,稿子照写
    outcome = { state: "unavailable", note: err instanceof Error ? err.message : String(err) };
  }
  if (waited) await retitlePlaceholder(placeholderId, "writing", req, warn, dataDir);
  if (outcome.state === "already" || outcome.state === "ready") return false;
  const detail = outcome.state === "timeout" ? "调研没在限时内跑完（可能还在跑）" : outcome.note;
  warn(`未带调研简报开写：${detail}`);
  return true;
}

interface WriterRun {
  payload: SubmitPayload;
  gateFailures: GateFailure[];
  /** 非空 = 硬门拦下了最后一稿：正文照存，但它不是成稿（稿件走 `needs_evidence`） */
  blocked?: CaptureBlock | null;
  /** 归一不了的模糊量词（十几、数十）：advisory，与无据数字一起列给创始人过目 */
  needsHumanNumbers: string[];
  tokensUsed: number;
  /** 写稿轮用了备用端点（P2 spec §4.3）：落进 Content.usedFallback，稿卡出徽章 */
  usedFallback?: LoopFallbackInfo;
}

/**
 * 写手的工具箱依赖（§4.4）：账本用 getter 传——写手在同一轮里用 `find_evidence` 查到的
 * 条目要当场对数字硬门生效，传快照就永远慢一拍。两个硬门开关与赛道包无关，恒定打开。
 */
function submitDepsFor(ledger: EvidenceLedger): SubmitGateDeps {
  return { ledger: () => ledger.entries(), requireNumberEvidence: true, forbidFormatMarkers: true };
}

/**
 * 写手回合预算（§4.4 / codex #12）：4 轮正常写作 + 每次 `find_evidence` 一轮 + 每轮修复两回合。
 * **不看包有没有 gate**：抖音包没有 qualityGate，但硬门照样会打回它，按 4 轮算等于让它
 * 在第一次打回之后无回合可用，交不出第二稿。
 */
function writerTurnBudget(gate: QualityGateSpec | undefined, ledger: EvidenceLedger): number {
  return 4 + ledger.budget.max + (gate?.maxRepairRounds ?? DEFAULT_REPAIR_ROUNDS) * 2;
}

/** 写稿轮：runLoop + submit_script 收束。没提交成稿 = 硬失败（调用方标〔生成中断〕）。 */
async function runWriterLoop(
  prompts: { system: string; user: string },
  gate: QualityGateSpec | undefined,
  config: EngineConfig,
  attribution: Attribution,
  loopFn: typeof runLoop,
  tools: { ledger: EvidenceLedger; evidenceTool?: LoopTool },
  runId?: string,
): Promise<WriterRun> {
  const writer = resolveEngineRoute(config, "writer", config.strongModel);
  const captured: Captured = createCapture();
  const result: LoopResult = await loopFn(writer.config, {
    model: writer.model,
    systemPrompt: prompts.system,
    userMessage: prompts.user,
    tools: [
      buildSubmitTool(captured, gate, submitDepsFor(tools.ledger)),
      // 搜索没配就没有这把工具——写手会在提示里看到「没有证据不要编」，而不是一个永远失败的工具
      ...(tools.evidenceTool ? [tools.evidenceTool] : []),
    ],
    maxTurns: writerTurnBudget(gate, tools.ledger),
    maxTotalTokens: WRITER_MAX_TOKENS,
    // 归因进 run-log 元数据(§3.5 卡 / 深调研 §6 简报 / P1 §4.4 角度与语料):没用到的字段不出现
    logMeta: { ...(runId ? { runId } : {}), agent: "writer", ...logAttribution(attribution) },
  });
  if (!captured.payload) {
    throw new Error(
      `脚本生成失败：模型未调用 submit_script 工具提交脚本（loop 状态：${result.stopReason}，turns=${result.turns}）`,
    );
  }
  return {
    ...(result.usedFallback ? { usedFallback: result.usedFallback } : {}),
    payload: captured.payload,
    gateFailures: captured.gateFailures,
    blocked: captured.blocked ?? null,
    needsHumanNumbers: captured.needsHumanNumbers ?? [],
    tokensUsed: result.totalTokens,
  };
}

/**
 * 审稿轮装配（审稿 §2.4「同批材料」）：写稿用的 system/user、研究槽、声音样本原样交给审稿人——
 * 审稿判「证据支撑住论点了吗」，靠的就是这批材料，少一块就少判一个维度。
 */
function reviewDraft(
  written: WriterRun,
  inputs: Pick<GenerationInputs, "config" | "profile" | "snapshot" | "angle" | "ledger">,
  prompts: { system: string; user: string },
  gate: QualityGateSpec | undefined,
  platform: ScriptRequest["platform"],
  deps: ReviewDeps,
  /** 写手手上那**一个** find_evidence 实例：额度在账本上共享，写手用掉的修订就没有了 */
  evidenceTool?: LoopTool,
): Promise<ReviewOutcome> {
  return reviewAndConverge(
    {
      payload: written.payload,
      // 组装 + 正则去 AI 味 = 终稿形态,审稿读的就是它（§2.1 正则前置）；全流程只做这一次
      humanizedText: assembleAndHumanize(written.payload),
      system: prompts.system,
      user: prompts.user,
      // 写手拿到的那份**同一个字符串**（§4.3）——审稿不再自己裁一刀
      ...(inputs.snapshot.text ? { researchSlot: inputs.snapshot.text } : {}),
      // 选中角度进审稿材料（审稿 §2.4）：深度判据的基准从「有没有论点」升到「thesis 论证了吗」
      ...(inputs.angle ? { angle: inputs.angle.card } : {}),
      voiceSamples: inputs.profile?.voiceSamples ?? [],
      ...(gate ? { gate } : {}),
      platform,
      canFindEvidence: Boolean(evidenceTool),
      // 硬门放行但要人工过目的模糊量词（§4.5 判据三 advisory）：审稿人替创始人先点一遍名
      needsHumanNumbers: written.needsHumanNumbers,
    },
    inputs.config,
    {
      ...deps,
      // 修订轮 = 同一本账、同一把 submit_script、同一个 find_evidence 实例（§3.3 / §4.4）
      submitDeps: submitDepsFor(inputs.ledger),
      ...(evidenceTool ? { evidenceTool } : {}),
      maxWriterTurns: writerTurnBudget(gate, inputs.ledger),
    },
  );
}

/** 执行体:写稿 → 组装+去 AI 味 → AI 审稿 → 占位稿转正;失败标〔生成中断〕+ lastError 后原样抛出 */
async function runGeneration(
  placeholderId: string,
  req: ScriptRequest,
  dataDir?: string,
  deps?: GenerationDeps,
  runId?: string,
): Promise<GeneratedScript> {
  const warn = deps?.onWarn ?? ((message: string) => console.warn(`[generate-script] ${message}`));
  // 调研闸口必须跑在材料收集**之前**:简报是本轮刚跑出来的,gatherInputs 才读得到指针
  const wroteWithoutBrief = await ensureBriefBeforeWriting(req, deps, warn, placeholderId, dataDir);

  try {
    return await withWallClock(
      () => writeAndFinalize({ placeholderId, req, wroteWithoutBrief, warn, dataDir, deps, runId }),
      deps?.wallClockMs ?? GENERATION_WALL_CLOCK_MS,
    );
  } catch (err) {
    await markInterrupted(placeholderId, req, err, dataDir);
    throw err;
  }
}

/**
 * 整稿墙钟（§4.4）。runLoop 不可强杀，到点只能**丢弃结果**——底层那轮请求会自然跑完
 * （token 上限兜底）。到点等于本轮作废：占位稿标〔生成中断〕，人点重试从头再来一次，
 * 而不是留一张永远停在「生成中」的卡（那和卡死没有区别）。
 */
async function withWallClock<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`脚本生成超时（${Math.round(ms / 1000)} 秒整稿墙钟）：本轮作废，可点「重新生成」重来`)),
      ms,
    );
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 材料收集 → 补证 → 写稿 → 审稿 → 转正/拦下。墙钟之内的全部工作都在这儿 */
async function writeAndFinalize(args: {
  placeholderId: string;
  req: ScriptRequest;
  wroteWithoutBrief: boolean;
  warn: (message: string) => void;
  dataDir?: string;
  deps?: GenerationDeps;
  runId?: string;
}): Promise<GeneratedScript> {
  const { placeholderId, req, wroteWithoutBrief, warn, dataDir, deps, runId } = args;
  // 材料收集(知识库检索也在执行体统一做——MCP 工具/桌面 IPC/chat-router 三条入口一次覆盖)
  const inputs = await gatherInputs(req, dataDir, warn, deps);
  const { config, pack, profile, contrastPairs, patterns, promptReq, angle, wroteWithoutAngle, attribution } = inputs;
  // 跳过角度是**用户的显式动作**（§1.6 不许模型猜布尔），所以它的原话要落 run-log 可回溯
  if (req.angleSkipReason?.trim()) warn(`用户明说跳过角度点选：${req.angleSkipReason.trim()}`);
  else if (wroteWithoutAngle) warn(`未经角度点选开写：这条选题有角度候选卡但没选（${req.topicId}）`);
  const prompts = buildScriptPrompts(pack, profile, promptReq, {
    contrastPairs,
    patterns,
    ...(angle ? { angle } : {}),
  });
  const gate = resolveQualityGate(pack, req.platform);
  // 账本先随占位稿落一次（§3.3）：写手还没开工，但补证已经花过钱了——
  // 这一步之后崩掉，「这稿当时手上有哪些证据」仍然查得到
  await persistAttribution(placeholderId, attribution, inputs.ledger, warn, dataDir);

  const evidenceTool = inputs.researcher ? buildFindEvidenceTool(inputs.researcher) : undefined;
  const written = await runWriterLoop(
    prompts,
    gate,
    config,
    attribution,
    deps?.runLoopImpl ?? runLoop,
    { ledger: inputs.ledger, ...(evidenceTool ? { evidenceTool } : {}) },
    runId,
  );
  // 兜底留痕（§4.3）：写手这轮切过备用就当场落盘——后面还有审稿与转正，
  // 崩在半路也不该把「这稿是备用写的」这件事一起丢掉。留痕失败不阻断写作。
  if (written.usedFallback) {
    await updateContent(placeholderId, { usedFallback: written.usedFallback }, dataDir).catch((err: unknown) =>
      warn(`兜底留痕落盘失败（${placeholderId}）：${err instanceof Error ? err.message : String(err)}`),
    );
  }
  const rulesApplied = profile ? rulesForPlatform(profile, req.platform).length : 0;
  const common = {
    req,
    rulesApplied,
    attribution,
    ledger: inputs.ledger,
    wroteWithoutBrief,
    wroteWithoutAngle,
    ...(inputs.evidenceNote ? { evidenceNote: inputs.evidenceNote } : {}),
    placeholderId,
    ...(dataDir ? { dataDir } : {}),
  };

  // 硬门拦下 = 这稿不进审稿也不转正（§4.4）：审一篇不能发的稿是浪费，
  // 更重要的是修订轮可能把「无据数字」改成另一个无据数字，看起来像修好了
  if (!isAcceptedCapture({ payload: written.payload, gateFailures: written.gateFailures, blocked: written.blocked })) {
    warn(`硬门拦下本稿（${written.blocked?.reason}）：稿件标「缺证据」，不转草稿就绪`);
    return finalizeBlocked({ ...common, written });
  }

  const reviewed = await reviewDraft(
    written,
    { config, profile, snapshot: inputs.snapshot, ...(angle ? { angle } : {}), ledger: inputs.ledger },
    prompts,
    gate,
    req.platform,
    {
      ...(deps?.runLoopImpl ? { runLoopImpl: deps.runLoopImpl } : {}),
      ...(runId ? { runId } : {}),
      onWarn: warn,
    },
    evidenceTool,
  );

  return finalizeScript({
    ...common,
    payload: reviewed.payload,
    humanizedText: reviewed.humanizedText,
    review: reviewed.review,
    tokensUsed: written.tokensUsed + reviewed.tokensUsed,
    // 采纳了修订稿就用修订稿的 gate 结果（必空）；没换稿沿用写稿轮的残余 FAIL
    gateFailures: reviewed.gateFailures ?? written.gateFailures,
    needsHumanNumbers: written.needsHumanNumbers,
  });
}

/** 归因落占位稿（best-effort）：写不进去只 warn——归因是留痕，不该反过来弄死写作 */
async function persistAttribution(
  placeholderId: string,
  attribution: Attribution,
  ledger: EvidenceLedger,
  warn: (message: string) => void,
  dataDir?: string,
): Promise<void> {
  try {
    await updateContent(placeholderId, contentAttribution(attribution, ledger), dataDir);
  } catch (err) {
    warn(`归因落盘失败（${placeholderId}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 写稿失败的人话（P2 spec §4.2 四条链路之二）。**只翻译线路故障**——
 * 「模型没调用 submit_script」「整稿墙钟到点」这类不是线路的病，套上「写稿专线连不上」
 * 就是用确定的语气说错话，原样说更诚实。
 * 端点归因现读配置：错误可能从任意深处冒上来，把 config 一路传下去只会污染十几个签名。
 */
export async function writeFailureText(err: unknown, dataDir?: string): Promise<string> {
  const classified = classifyEngineError(err);
  const raw = cleanErrorMessage(err);
  if (!isEngineFailure(classified)) return raw;
  try {
    const config = await loadEngineConfig(dataDir);
    const writer = resolveEngineRoute(config, "writer", config.strongModel);
    const id = writer.config.activeProvider?.id ?? "main";
    const provider = (config.providers ?? []).find((p) => p.id === id);
    return describeEngineFailure({
      role: "writer",
      provider: { id, host: hostOf(provider?.baseUrl ?? writer.config.baseUrl) },
      classified,
      fallbackAvailable: Boolean(config.fallback),
    });
  } catch {
    return raw; // 配置都读不出来了：原样说，别编端点名
  }
}

/** 失败留痕:占位稿标〔生成中断〕+ lastError（best-effort,不吞原错误）——UI 据此显示徽章与重试入口 */
async function markInterrupted(
  placeholderId: string,
  req: ScriptRequest,
  err: unknown,
  dataDir?: string,
): Promise<void> {
  try {
    await updateContent(
      placeholderId,
      {
        title: `${INTERRUPTED_TITLE_PREFIX}${req.topic.slice(0, 40)}`,
        lastError: await writeFailureText(err, dataDir),
      },
      dataDir,
    );
  } catch {
    /* 留痕失败不掩盖原错误 */
  }
}

/** 同步版（MCP 外部 agent 与测试用:调用方要等成稿） */
export async function generateScript(
  req: ScriptRequest,
  dataDir?: string,
  deps?: GenerationDeps,
): Promise<GeneratedScript> {
  const placeholderId = await createPlaceholder(req, dataDir);
  return runGeneration(placeholderId, req, dataDir, deps);
}

export interface BackgroundGenEvent {
  role: "writer" | "system";
  kind: "work" | "run_done" | "run_failed";
  label: string;
  contentId?: string;
  runId: string;
}

export interface StartedGeneration {
  contentId: string;
  runId: string;
  /** 后台执行句柄——生产忽略,测试 await 用（fire-and-forget 的可测性口子） */
  completion: Promise<void>;
}

/** run_done 标签上的审稿结论（与「（未带简报）」并列，各说各的事） */
function reviewBrand(review: ReviewMeta): string {
  if (review.status === "skipped") return "（未经AI审稿）";
  if (review.status === "failed") {
    const left = review.issues.filter((i) => i.severity === "blocker").length;
    return `（审稿未过,残留${left}项）`;
  }
  return "（已审稿）";
}

type BackgroundDeps = GenerationDeps & { onEvent?: (e: BackgroundGenEvent) => void };

/**
 * 后台执行体（新写与中断重写共用）。占位稿已经存在——本函数只负责起 run、
 * 播事件、把失败关在 run_failed 里（后台任务不该向调用方 reject:投递已经成功了）。
 * `workLabel` 由调用方给：任务带上「开写」与「重写」要能一眼分开。
 */
function runInBackground(
  contentId: string,
  req: ScriptRequest,
  workLabel: string,
  dataDir?: string,
  deps?: BackgroundDeps,
): StartedGeneration {
  const runId = `run-bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const emit = (e: BackgroundGenEvent) => { try { deps?.onEvent?.(e); } catch { /* 观测层吞错 */ } };

  const completion = (async () => {
    emit({ role: "writer", kind: "work", label: workLabel, contentId, runId });
    try {
      const result = await runGeneration(contentId, req, dataDir, deps, runId);
      // 「没材料写的」「没过 AI 审稿的」都要在工作日志上自己说出来——
      // 人看到标签才知道这稿该多挑一点（审稿 §2.5：run_done 追加审稿结论）
      const brand = result.wroteWithoutBrief ? "（未带简报）" : "";
      // 硬门拦下的稿不是「写完待审改」——说成写完了，人就不会去补材料（§4.4）
      const label = result.needsEvidence
        ? `《${result.title.slice(0, 24)}》被数字硬门拦下:有 ${result.unverifiedNumbers.length} 个数字没有出处,稿件标「缺证据」${brand}`
        : `《${result.title.slice(0, 24)}》写完,待审改${brand}${reviewBrand(result.review)}`;
      emit({ role: "system", kind: "run_done", label, contentId, runId });
    } catch (err) {
      // 工作日志上那一行也说人话（§4.2）：「编剧写稿中断：502 {…fetch failed}」帮不了任何人
      const msg = await writeFailureText(err, dataDir);
      emit({ role: "writer", kind: "run_failed", label: `编剧写稿中断：${msg.slice(0, 80)}`, contentId, runId });
    }
  })();
  return { contentId, runId, completion };
}

/**
 * 后台化入口（契约 P1 工程项完全体）:提交即返回占位稿 id,生成在进程后台跑,
 * HTTP 请求/页面刷新与任务生命周期彻底解耦。进度经 onEvent 回调外发
 * （调用方注入 emitEngineEvent——modules 层不依赖 desktop 层）。
 */
export function startGenerateScript(
  req: ScriptRequest,
  dataDir?: string,
  deps?: BackgroundDeps,
): Promise<StartedGeneration> {
  return createPlaceholder(req, dataDir).then((contentId) =>
    runInBackground(contentId, req, `编剧开写《${req.topic.slice(0, 24)}》`, dataDir, deps),
  );
}

/**
 * 中断稿原地重写。**不新建稿件**——这是整条重试链的要点：老路是「重试 = 再派一次活」，
 * 于是中断稿成僵尸卡、每重试一次看板多一张重复卡（2026-08-24 缺陷）。
 *
 * 只认「有 lastError」或「缺证据」的稿：没有这两个记号的稿子重写就是拿一篇好稿去赌，
 * 用户要的是改稿（revise_draft）而不是推倒重来。
 * 重置发生在起 run 之前——标题回［生成中］、lastError 清空，看板当场变回「在写」。
 */
export async function retryGenerateScript(
  contentId: string,
  dataDir?: string,
  deps?: BackgroundDeps,
  /**
   * 用户这一轮刚提的新要求（对话入口会带；编辑器的「重新生成」按钮不带）。
   * 盖在原请求之上而不是替换它：换了角度就按新角度写，这次没重提的（比如上回贴的
   * 调研材料）照旧保留——两个方向的静默丢失都不可接受。**只放真给了值的键**，
   * 带 undefined 进来等于把原请求那一格擦掉。
   */
  override?: Partial<ScriptRequest>,
): Promise<StartedGeneration> {
  const content = await getContent(contentId, dataDir);
  if (!content) throw new Error(`稿件不存在（${contentId}）`);
  // 「缺证据」和「写崩了」是同一类可重写态（P1 §4.4）：两者都是**没写成**的稿，
  // 区别只在一个是硬门拦的、一个是跑崩的。没有这两个记号的稿子重写就是拿好稿去赌。
  const blocked = content.status === "needs_evidence";
  if (!content.lastError && !blocked) {
    throw new Error("这稿没有中断记录,不能重写——要改稿请直接说怎么改");
  }

  const req: ScriptRequest = { ...rebuildRequest(content), ...override };
  await updateContent(
    contentId,
    {
      title: `${GENERATING_TITLE_PREFIX}${req.topic.slice(0, 40)}`,
      lastError: null,
      // 重写即清上一轮的拦截痕：新一轮会重新判，留着旧清单只会让看板显示两个事实
      ...(blocked ? { blockedReason: null, unverifiedNumbers: [] } : {}),
      _versionNote: blocked ? "缺证据重写:补材料后在原稿上重来一次" : "中断重写:在原稿上重来一次",
    },
    dataDir,
  );
  // needs_evidence 稿要先退回 drafting——占位稿的整条流程都假定自己是「写作中」
  if (blocked) {
    const back = await transitionStatus(contentId, "drafting", {}, dataDir);
    if (!back.ok) throw new Error(`稿件退回写作中失败（${contentId}）：${back.error ?? "状态未推进"}`);
  }
  return runInBackground(contentId, req, `编剧重写《${req.topic.slice(0, 24)}》`, dataDir, deps);
}

/** 转正与拦下两条路共用的一份上下文 */
interface FinalizeCommon {
  req: ScriptRequest;
  rulesApplied: number;
  attribution: Attribution;
  ledger: EvidenceLedger;
  wroteWithoutBrief: boolean;
  wroteWithoutAngle: boolean;
  /** 补证降级（未补证 / 补证失败）：进版本注记 */
  evidenceNote?: string;
  placeholderId: string;
  dataDir?: string;
}

interface FinalizeArgs extends FinalizeCommon {
  /** 审稿后的最终 payload（未修订时即写稿原样） */
  payload: SubmitPayload;
  /** 审稿后的最终正文（组装 + humanize 已在审稿前做过一次，这里不再重做） */
  humanizedText: string;
  review: ReviewMeta;
  tokensUsed: number;
  gateFailures: GateFailure[];
  /** 归一不了的模糊量词：放行但要人过目（§5） */
  needsHumanNumbers: string[];
}

/**
 * 版本注记：稿件历史里唯一的人话留痕。四件事要在同一句里说清楚——
 * 这稿有没有材料垫底、有没有经过角度点选、补证有没有跑成、审稿有没有让它改过。
 * 别互相覆盖，也别堆成四串括号。
 */
function versionNote(
  review: ReviewMeta,
  marks: { wroteWithoutBrief: boolean; wroteWithoutAngle: boolean; evidenceNote?: string },
): string {
  const notes = [
    ...(marks.wroteWithoutBrief ? ["未带调研简报"] : []),
    ...(marks.wroteWithoutAngle ? ["未经角度点选"] : []),
    ...(marks.evidenceNote ? [marks.evidenceNote] : []),
  ];
  if (review.rounds > 0) return `AI 审稿修订（${review.fixed} 项${notes.length ? `，${notes.join("、")}` : ""}）`;
  return notes.length ? `AI 完成初稿（${notes.join("、")}）` : "AI 完成初稿";
}

/** 空审稿结论：硬门拦下的稿压根没进审稿轮，但 `review` 字段必须有值（读侧不分支） */
function unreviewed(): ReviewMeta {
  return { status: "skipped", rounds: 0, fixed: 0, issues: [], reviewedAt: new Date().toISOString() };
}

/**
 * 硬门拦下（§4.4 / §5「数字无据且修复耗尽」）：正文照落盘、状态走 `needs_evidence`。
 *
 * 为什么正文要存：创始人得看见被拦的是**哪一稿**才判断得了「这个数删掉还是我去找来源」。
 * 为什么不盖 `draftReadyAt`：那枚戳的语义是「稿成」，这稿没成。
 */
async function finalizeBlocked(args: FinalizeCommon & { written: WriterRun }): Promise<GeneratedScript> {
  const { written, req, placeholderId, dataDir } = args;
  const humanizedText = assembleAndHumanize(written.payload);
  const unverified = [...blockedNumbersOf(written), ...written.needsHumanNumbers];
  const scanResult = await scanText(`${written.payload.title}\n\n${humanizedText}`, req.platform, dataDir);
  const review = unreviewed();

  const content = await updateContent(
    placeholderId,
    {
      title: written.payload.title,
      body: humanizedText,
      hashtags: written.payload.hashtags.map((t) => t.trim()).filter(Boolean),
      // genRequest **不清**：这稿还要重写，重写的依据就是它
      lastError: null,
      blockedReason: written.blocked?.detail ?? "硬门未通过",
      unverifiedNumbers: unverified,
      ...contentAttribution(args.attribution, args.ledger),
      review,
      _versionNote: `缺证据，未转草稿（${versionNote(review, args)}）`,
    },
    dataDir,
  );
  if (!content) throw new Error(`占位稿丢失（${placeholderId}）：硬门拦下的稿件内容未保存`);

  const moved = await transitionStatus(placeholderId, "needs_evidence", {}, dataDir);
  if (!moved.ok) {
    throw new Error(`稿件状态推不动（${placeholderId} → needs_evidence）：${moved.error ?? "状态未推进"}；正文已保存`);
  }
  return {
    contentId: content.id,
    title: written.payload.title,
    body: humanizedText,
    hashtags: content.hashtags,
    violations: scanResult.hits.map((h) => h.word),
    gateFailures: written.gateFailures.map((f) => f.detail),
    rulesApplied: args.rulesApplied,
    wroteWithoutBrief: args.wroteWithoutBrief,
    wroteWithoutAngle: args.wroteWithoutAngle,
    review,
    needsEvidence: true,
    ...(written.blocked?.detail ? { blockedReason: written.blocked.detail } : {}),
    unverifiedNumbers: unverified,
    tokensUsed: written.tokensUsed,
  };
}

/** 硬门打回文案里那份「哪些数字没据」的清单——detail 是给模型的人话，这里只取一行摘要 */
function blockedNumbersOf(written: WriterRun): string[] {
  const failure = written.gateFailures.find((f) => f.check === "unverified_numbers");
  if (!failure) return [];
  return failure.detail
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

/** 后处理：违禁词扫描 → 占位稿转正（draft_ready，同现有写作流）。 */
async function finalizeScript(args: FinalizeArgs): Promise<GeneratedScript> {
  const { payload, humanizedText, review, req, attribution, wroteWithoutBrief, wroteWithoutAngle, placeholderId, dataDir } =
    args;
  const { title, hashtags } = payload;
  const needsHuman = args.needsHumanNumbers;

  // 标题一并扫描——与 review.ts 的 `title\n\nbody` 口径对齐，标题里的违禁词不得漏报
  const scanResult = await scanText(`${title}\n\n${humanizedText}`, req.platform, dataDir);
  const violations = scanResult.hits.map((h) => h.word);

  const cleanHashtags = hashtags.map((t) => t.trim()).filter(Boolean);

  // 占位稿转正（P1）:同一个 id 从 drafting 占位变成成品,清掉历史失败痕
  const content = await updateContent(
    placeholderId,
    {
      title,
      body: humanizedText,
      // 生产计时的「稿成」节点:转正这一刻就是稿成:起点是占位稿的 createdAt(开写)
      draftReadyAt: new Date().toISOString(),
      hashtags: cleanHashtags,
      lastError: null,
      // 转正即清:成稿没有「中断」可重试,留着这份请求只是 meta 里一处会骗人的旧事实
      genRequest: undefined,
      // 转正即清：这稿过了硬门，上一轮（如果有）留下的「缺证据」痕迹不该跟着成稿走
      blockedReason: null,
      // 模糊量词照样落盘：它不拦门，但创始人要能一眼看到「这几个数没法核」（§5）
      unverifiedNumbers: needsHuman,
      // 归因落稿件元数据(§3.5 卡 / 深调研 §6 简报 / P1 §3.2 语料 §3.3 账本):没用到就不写字段
      ...contentAttribution(attribution, args.ledger),
      // 审稿结论落稿件元数据(审稿 §2.5):稿卡徽章读的就是它,降级路径同样要留下
      review,
      _versionNote: versionNote(review, { wroteWithoutBrief, wroteWithoutAngle, ...(args.evidenceNote ? { evidenceNote: args.evidenceNote } : {}) }),
    },
    dataDir,
  );
  if (!content) {
    throw new Error(`占位稿丢失（${placeholderId}）：生成完成但无法转正,稿件内容未保存`);
  }
  // 状态另走收口通道（阶段制 spec §1.2）：正文已经落盘,这一步只把 drafting 推到 draft_ready。
  // 推不动就抛——留一篇正文齐全却仍标着「写作中」的稿,比当场报错更难查。
  const promoted = await transitionStatus(placeholderId, "draft_ready", {}, dataDir);
  if (!promoted.ok) {
    throw new Error(`占位稿转正失败（${placeholderId}）：${promoted.error ?? "状态未推进"}；正文已保存`);
  }

  return {
    contentId: content.id,
    title,
    body: humanizedText,
    hashtags: cleanHashtags,
    violations,
    gateFailures: args.gateFailures.map((f) => f.detail),
    rulesApplied: args.rulesApplied,
    wroteWithoutBrief,
    wroteWithoutAngle,
    review,
    needsEvidence: false,
    unverifiedNumbers: needsHuman,
    tokensUsed: args.tokensUsed,
  };
}
