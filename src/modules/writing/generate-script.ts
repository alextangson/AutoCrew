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
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import type { EngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopResult } from "../../engine/loop.js";
import { getPack, getPackForPlatform } from "../packs/index.js";
import type { QualityGateSpec } from "../packs/pack-schema.js";
import { loadProfile } from "../profile/creator-profile.js";
import { recentContrastPairs } from "../learnings/diff-tracker.js";
import { buildScriptPrompts } from "./script-prompt.js";
import type { ScriptRequest } from "./script-prompt.js";
import { selectPatternsForScript } from "../patterns/pattern-select.js";
import type { PatternCard } from "../patterns/pattern-store.js";
import { resolveQualityGate } from "./quality-gate.js";
import type { GateFailure } from "./quality-gate.js";
import { assembleAndHumanize, buildSubmitTool } from "./script-payload.js";
import type { Captured, SubmitPayload } from "./script-payload.js";
import { reviewAndConverge } from "./script-review.js";
import type { ReviewDeps, ReviewMeta, ReviewOutcome } from "./script-review.js";
import { scanText } from "../filter/sensitive-words.js";
import { retrieveKnowledge, KNOWLEDGE_DEFAULT_CHARS } from "../knowledge/knowledge-base.js";
import { buildBriefBlock, knowledgeBudgetFor } from "../research/brief-inject.js";
import { loadBrief } from "../research/brief-store.js";
import { getJob, topicHashOf } from "../research/research-job-store.js";
import { getContent, getDataDir, getTopic, saveContent, updateContent } from "../../storage/local-store.js";
import type { Content } from "../../storage/local-store.js";
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
  /** AI 审稿结论（审稿 spec §2.5）：降级路径也一定有值——skipped/failed 就是「没审成」的留痕 */
  review: ReviewMeta;
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
}

/** 本稿的归因元数据——两条落点（run-log 的 logMeta 与 content 元数据）共用同一份 */
interface Attribution {
  usedPatternIds: string[];
  /** 本稿注入的简报版本（§6）：无简报时字段不出现，日志与稿件口径与改动前一字不差 */
  usedBriefRevision?: number;
}

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

/**
 * 取「当前有效简报」并渲染成注入块（深调研 spec §6）。
 *
 * `job.briefRevision` 是唯一指针（§2「重跑读语义」）：**没有指针就是没有简报**，
 * 绝不用「最新一版」兜底——重跑失败时兜底会把没被采纳的那版偷偷注进稿子里。
 * 读侧任何故障都降级成「无简报」并 warn：写稿宁可少一块材料，也不该整条链断掉。
 */
async function loadBriefBlock(
  req: ScriptRequest,
  dataDir: string | undefined,
  warn: (message: string) => void,
): Promise<{ block: string; revision: number } | null> {
  if (!req.topicId) return null;
  const dir = getDataDir(dataDir);
  try {
    const job = await getJob(req.topicId, dir);
    if (!job || job.briefRevision === undefined) return null;
    const brief = await loadBrief(req.topicId, job.briefRevision, dir, warn);
    if (!brief) return null; // 坏文件/未知 schemaVersion：loadBrief 已经 warn 过
    const topic = await getTopic(req.topicId, dataDir);
    if (!topic) warn(`选题 ${req.topicId} 已不在库中，简报按「基于旧版选题」标注注入`);
    // 核对不上就当过期：选题查不到时不给这份简报背书（§2 过期标注，注入照做）
    const topicStale = !topic || topicHashOf(topic.title, topic.description) !== brief.topicHash;
    return { block: buildBriefBlock(brief, { topicStale }), revision: brief.revision };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`调研简报读取失败（${req.topicId}），本稿按无简报写：${msg}`);
    return null;
  }
}

/**
 * research 槽装配（§6 预算表）：用户材料在前，简报块**优先占用**预算，
 * 知识库检索只能用剩余的；剩余不足 `KNOWLEDGE_MIN_BUDGET` 时知识块整体省略。
 * 无简报时走的还是老路（知识库用它自己的默认预算），prompt 与改动前逐字一致。
 */
async function composeResearchSlot(
  req: ScriptRequest,
  briefBlock: string | undefined,
  dataDir?: string,
): Promise<ScriptRequest> {
  const budget = briefBlock
    ? knowledgeBudgetFor(
        { briefChars: briefBlock.length, userResearchChars: req.research?.length ?? 0 },
        KNOWLEDGE_DEFAULT_CHARS,
      )
    : KNOWLEDGE_DEFAULT_CHARS;
  const knowledge = budget === null ? null : await retrieveKnowledge(req.topic, dataDir, { maxChars: budget });

  const extras = [briefBlock, knowledge].filter((s): s is string => !!s);
  if (extras.length === 0) return req; // 无简报无知识：req 原样透传，prompt 一字不变
  return { ...req, research: [req.research, ...extras].filter(Boolean).join("\n\n") };
}

interface GenerationInputs {
  config: Awaited<ReturnType<typeof loadEngineConfig>>;
  pack: ReturnType<typeof getPack>;
  profile: Awaited<ReturnType<typeof loadProfile>>;
  contrastPairs: Awaited<ReturnType<typeof recentContrastPairs>>;
  patterns: PatternCard[];
  /** research 槽装配完的请求（用户材料 + 简报 + 知识片段） */
  promptReq: ScriptRequest;
  attribution: Attribution;
}

/** 写稿前的材料收集：能并行的一起拿，知识库要等简报长度定了才知道自己的预算 */
async function gatherInputs(
  req: ScriptRequest,
  dataDir: string | undefined,
  warn: (message: string) => void,
): Promise<GenerationInputs> {
  const [config, pack, profile, contrastPairs, patterns, brief] = await Promise.all([
    loadEngineConfig(dataDir),
    Promise.resolve(req.packId ? getPack(req.packId) : getPackForPlatform(req.platform)),
    loadProfile(dataDir),
    // 改稿对比对(V5.7 活人感):读取失败不阻断写稿——样例是增强,不是依赖
    recentContrastPairs(3, dataDir).catch(() => []),
    // 对标拆解卡(收件箱 §3.5):平台+主题相关才选,无匹配即空数组。
    // 这里**不加 catch**:patterns 库不存在是正常空态(store 已按 ENOENT 返回 []),
    // 其余读故障必须炸出来——静默降级会让「卡怎么没生效」查无可查。
    selectPatterns(req, dataDir),
    // 调研简报(深调研 §6):三条写稿入口共用这一处注入点,无 topicId/无指针即 null
    loadBriefBlock(req, dataDir, warn),
  ]);
  return {
    config,
    pack,
    profile,
    contrastPairs,
    patterns,
    promptReq: await composeResearchSlot(req, brief?.block, dataDir),
    attribution: {
      usedPatternIds: patterns.map((card) => card.id),
      ...(brief ? { usedBriefRevision: brief.revision } : {}),
    },
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
  tokensUsed: number;
}

/** 写稿轮：runLoop + submit_script 收束。没提交成稿 = 硬失败（调用方标〔生成中断〕）。 */
async function runWriterLoop(
  prompts: { system: string; user: string },
  gate: QualityGateSpec | undefined,
  config: EngineConfig,
  attribution: Attribution,
  loopFn: typeof runLoop,
  runId?: string,
): Promise<WriterRun> {
  const writer = resolveEngineRoute(config, "writer", config.strongModel);
  const captured: Captured = { payload: null, gateFailures: [] };
  const result: LoopResult = await loopFn(writer.config, {
    model: writer.model,
    systemPrompt: prompts.system,
    userMessage: prompts.user,
    tools: [buildSubmitTool(captured, gate)],
    // Gate 修复轮需要额外回合与 token 预算（整稿 × 最多 1+N 稿）
    maxTurns: gate ? 4 + (gate.maxRepairRounds ?? 2) * 2 : 4,
    maxTotalTokens: gate ? 80000 : undefined,
    // 归因进 run-log 元数据(§3.5 卡 / 深调研 §6 简报):没用到的字段不出现,日志口径不变
    logMeta: {
      ...(runId ? { runId } : {}),
      agent: "writer",
      ...(attribution.usedPatternIds.length > 0 ? { usedPatternIds: attribution.usedPatternIds } : {}),
      ...(attribution.usedBriefRevision !== undefined
        ? { usedBriefRevision: attribution.usedBriefRevision }
        : {}),
    },
  });
  if (!captured.payload) {
    throw new Error(
      `脚本生成失败：模型未调用 submit_script 工具提交脚本（loop 状态：${result.stopReason}，turns=${result.turns}）`,
    );
  }
  return { payload: captured.payload, gateFailures: captured.gateFailures, tokensUsed: result.totalTokens };
}

/**
 * 审稿轮装配（审稿 §2.4「同批材料」）：写稿用的 system/user、研究槽、声音样本原样交给审稿人——
 * 审稿判「证据支撑住论点了吗」，靠的就是这批材料，少一块就少判一个维度。
 */
function reviewDraft(
  written: WriterRun,
  inputs: Pick<GenerationInputs, "config" | "profile" | "promptReq">,
  prompts: { system: string; user: string },
  gate: QualityGateSpec | undefined,
  platform: ScriptRequest["platform"],
  deps: ReviewDeps,
): Promise<ReviewOutcome> {
  return reviewAndConverge(
    {
      payload: written.payload,
      // 组装 + 正则去 AI 味 = 终稿形态,审稿读的就是它（§2.1 正则前置）；全流程只做这一次
      humanizedText: assembleAndHumanize(written.payload),
      system: prompts.system,
      user: prompts.user,
      ...(inputs.promptReq.research ? { researchSlot: inputs.promptReq.research } : {}),
      voiceSamples: inputs.profile?.voiceSamples ?? [],
      ...(gate ? { gate } : {}),
      platform,
    },
    inputs.config,
    deps,
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
  // 材料收集(知识库检索也在执行体统一做——MCP 工具/桌面 IPC/chat-router 三条入口一次覆盖)
  const { config, pack, profile, contrastPairs, patterns, promptReq, attribution } =
    await gatherInputs(req, dataDir, warn);
  const prompts = buildScriptPrompts(pack, profile, promptReq, { contrastPairs, patterns });
  const gate = resolveQualityGate(pack, req.platform);

  try {
    const written = await runWriterLoop(prompts, gate, config, attribution, deps?.runLoopImpl ?? runLoop, runId);
    const reviewed = await reviewDraft(written, { config, profile, promptReq }, prompts, gate, req.platform, {
      ...(deps?.runLoopImpl ? { runLoopImpl: deps.runLoopImpl } : {}),
      ...(runId ? { runId } : {}),
      onWarn: warn,
    });

    return await finalizeScript({
      payload: reviewed.payload,
      humanizedText: reviewed.humanizedText,
      review: reviewed.review,
      req,
      tokensUsed: written.tokensUsed + reviewed.tokensUsed,
      // 采纳了修订稿就用修订稿的 gate 结果（必空）；没换稿沿用写稿轮的残余 FAIL
      gateFailures: reviewed.gateFailures ?? written.gateFailures,
      rulesApplied: profile ? rulesForPlatform(profile, req.platform).length : 0,
      attribution,
      wroteWithoutBrief,
      placeholderId,
      dataDir,
    });
  } catch (err) {
    await markInterrupted(placeholderId, req, err, dataDir);
    throw err;
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
        lastError: err instanceof Error ? err.message : String(err),
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
      emit({
        role: "system",
        kind: "run_done",
        label: `《${result.title.slice(0, 24)}》写完,待审改${brand}${reviewBrand(result.review)}`,
        contentId,
        runId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ role: "writer", kind: "run_failed", label: `编剧写稿中断：${msg.slice(0, 60)}`, contentId, runId });
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
 * 只认「有 lastError」的稿：没有中断记录的稿子重写就是拿一篇好稿去赌，
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
  if (!content.lastError) throw new Error("这稿没有中断记录,不能重写——要改稿请直接说怎么改");

  const req: ScriptRequest = { ...rebuildRequest(content), ...override };
  await updateContent(
    contentId,
    {
      title: `${GENERATING_TITLE_PREFIX}${req.topic.slice(0, 40)}`,
      lastError: null,
      _versionNote: "中断重写:在原稿上重来一次",
    },
    dataDir,
  );
  return runInBackground(contentId, req, `编剧重写《${req.topic.slice(0, 24)}》`, dataDir, deps);
}

interface FinalizeArgs {
  /** 审稿后的最终 payload（未修订时即写稿原样） */
  payload: SubmitPayload;
  /** 审稿后的最终正文（组装 + humanize 已在审稿前做过一次，这里不再重做） */
  humanizedText: string;
  review: ReviewMeta;
  req: ScriptRequest;
  tokensUsed: number;
  gateFailures: GateFailure[];
  rulesApplied: number;
  attribution: Attribution;
  wroteWithoutBrief: boolean;
  placeholderId: string;
  dataDir?: string;
}

/**
 * 版本注记：稿件历史里唯一的人话留痕。两件事要在同一句里说清楚——
 * 这稿有没有材料垫底、审稿有没有让它改过。别互相覆盖，也别堆成两串括号。
 */
function versionNote(review: ReviewMeta, wroteWithoutBrief: boolean): string {
  const head = review.rounds > 0 ? `AI 审稿修订（${review.fixed} 项` : "AI 完成初稿";
  if (review.rounds > 0) return `${head}${wroteWithoutBrief ? "，未带调研简报" : ""}）`;
  return wroteWithoutBrief ? "AI 完成初稿（未带调研简报）" : head;
}

/** 后处理：违禁词扫描 → 占位稿转正（draft_ready，同现有写作流）。 */
async function finalizeScript(args: FinalizeArgs): Promise<GeneratedScript> {
  const { payload, humanizedText, review, req, attribution, wroteWithoutBrief, placeholderId, dataDir } = args;
  const { title, hashtags } = payload;

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
      status: "draft_ready",
      // 生产计时的「稿成」节点:转正这一刻就是稿成:起点是占位稿的 createdAt(开写)
      draftReadyAt: new Date().toISOString(),
      hashtags: cleanHashtags,
      lastError: null,
      // 转正即清:成稿没有「中断」可重试,留着这份请求只是 meta 里一处会骗人的旧事实
      genRequest: undefined,
      // 归因落稿件元数据(§3.5 卡 / 深调研 §6 简报):没用到就不写字段——与改动前一字不差
      ...(attribution.usedPatternIds.length > 0 ? { usedPatternIds: attribution.usedPatternIds } : {}),
      ...(attribution.usedBriefRevision !== undefined
        ? { usedBriefRevision: attribution.usedBriefRevision }
        : {}),
      // 审稿结论落稿件元数据(审稿 §2.5):稿卡徽章读的就是它,降级路径同样要留下
      review,
      _versionNote: versionNote(review, wroteWithoutBrief),
    },
    dataDir,
  );
  if (!content) {
    throw new Error(`占位稿丢失（${placeholderId}）：生成完成但无法转正,稿件内容未保存`);
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
    review,
    tokensUsed: args.tokensUsed,
  };
}
