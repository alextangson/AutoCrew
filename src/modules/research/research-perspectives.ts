/**
 * 视角子运行（深调研 spec §4）：一个视角 = 一次 runLoop，工具带 = broker 背书的
 * `search`/`read_page`（对标视角另挂只读 `list_patterns`）+ 收束工具 `submit_perspective`。
 *
 * 四条纪律：
 * 1. **出网只走 broker**：配额、缓存、来源登记、素材候选都在它那儿；`BrokerQuotaError`
 *    捕获后当作工具返回值告诉模型「配额已尽，用手上的材料收束」——配额用完是预期状态，
 *    不是异常，整路不能因此崩掉。
 * 2. **证据不可伪造**：sourceIds 必须是 broker 登记过的 id，evidence 逐条过
 *    `broker.validateQuote`，失败把 reason **原样**喂回修复轮（≤2 轮）。
 * 3. **成功判定收紧**：结构合法且**合法洞察 ≥2 条**，每条都带有效来源（§4「P1-13」）。
 * 4. **三层预算合围**：runLoop 的 maxTurns/token 是「下一轮前检查」的软上限，broker 配额是
 *    硬闸，墙钟 deadline 是最后一道。deadline 到点只能**丢弃结果**——runLoop 不可中断，
 *    底层那轮请求会自然跑完（token 上限兜底）；同时把本路标记为已弃，工具立即停止
 *    继续消耗**四路共享**的 broker 配额（这是弃标记存在的全部理由）。
 */
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import type { EngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopResult, LoopTool } from "../../engine/loop.js";
import { listPatternCards } from "../patterns/pattern-store.js";
import type { PatternCard } from "../patterns/pattern-store.js";
import { personaSummary } from "../profile/creator-profile.js";
import type { CreatorProfile } from "../profile/creator-profile.js";
import type { ResearchBroker } from "./research-broker.js";
import type { PerspectiveName } from "./research-job-store.js";
import type { PerspectiveOutput } from "./brief-store.js";
import {
  buildListPatternsTool,
  buildReadPageTool,
  buildSearchTool,
  type RunState,
} from "./research-tools.js";
import {
  INJECTION_NOTICE,
  captureSubmit,
  clampChars,
  newCapture,
  objList,
  str,
  strList,
  type Checked,
  type SubmitCapture,
} from "./research-prompt-kit.js";

// ─── 预算常量（§3「三层合围」） ──────────────────────────────────────────────

/** 首搜 + 若干读页 + 首提 + 2 次修复 + 收尾，8 轮够用又不放任 */
const MAX_TURNS = 8;
/** 每视角输出 token 上限（§3）；也是 deadline 丢弃结果后的最终兜底 */
const MAX_TOTAL_TOKENS = 15_000;
/** 每视角墙钟上限 8 分钟——spec §3 原定 4 分钟，真实网络+中转首跑三路全超时（2026-07-26 冒烟），加倍 */
export const DEFAULT_PERSPECTIVE_DEADLINE_MS = 480_000;

const TOPIC_TITLE_MAX_CHARS = 120;
const TOPIC_DESC_MAX_CHARS = 600;

const INSIGHT_MIN = 2;
const INSIGHT_MAX = 6;
const EVIDENCE_MAX = 8;
const ASSET_PICK_MAX = 10;

// ─── 四视角任务书（差异全在这张表里） ────────────────────────────────────────

interface PerspectiveTaskBook {
  /** 中文标签，进 prompt 也进日志 */
  label: string;
  mission: string[];
}

export const PERSPECTIVE_TASK_BOOKS: Record<PerspectiveName, PerspectiveTaskBook> = {
  audience: {
    label: "受众痛点",
    mission: [
      "你替**受众**读这个选题：他们为什么会点、看完能拿走什么、哪一句会让他们停下滑动。",
      "紧扣下面给出的受众画像三层（核心/邻近/意外）：洞察要落到具体人群的具体处境，",
      "「大家都很关心」这种谁都适用的话一条都不要；找的是他们真实说出口的困扰与场景。",
      "优先检索真实用户口径的材料（问答、评论、社区吐槽、亲历叙述），不要只看官方通稿。",
    ],
  },
  evidence: {
    label: "证据与数据",
    mission: [
      "你负责**把这个选题坐实**：数字、时间点、具体案例、可核验的出处。",
      "每条洞察都要能指到具体来源；能摘到原文的一律进 evidence，**逐字摘抄**页面原文，",
      "一个字都不要改写或转述——引文会被代码逐条回原页校验，改写必被打回。",
      "引文取 15~60 字的短句，宁短勿长：从 read_page 显示的正文里直接复制粘贴。",
      "没有数字或案例支撑的漂亮话不如不写；数据有冲突就把冲突本身当作发现记下来。",
    ],
  },
  counter: {
    label: "反方",
    mission: [
      "你的任务是**找这个选题站不住的理由**：反例、已经过时的前提、被夸大的收益、",
      "利益相关的信息源、样本太小的结论、只在特定条件下成立的说法。",
      "不是为了唱反调——是让我们提前知道读者会在哪一句底下反驳我们，写的时候先接住。",
      "找不到硬反驳也要如实说（记进 gaps），不要编造一个假的反方观点凑数。",
    ],
  },
  benchmark: {
    label: "对标",
    mission: [
      "你负责**这个选题该怎么讲**：先调用 list_patterns 看我们自己攒的同主题爆款拆解卡，",
      "它们是已经被验证过的骨架——先判断够不够用，不够再去搜同题材的公开内容补。",
      "洞察要落到可执行的表达选择：用什么钩子开场、按什么结构推进、哪里最容易掉人。",
      "别把别人的选题原样搬回来，我们要的是打法。",
    ],
  },
};

// ─── 契约 ────────────────────────────────────────────────────────────────────

/** 只取 topicHash 的两个字段：调研对象就是「标题 + 描述」 */
export interface ResearchTopicRef {
  title: string;
  description: string;
}

export type PatternLister = () => Promise<PatternCard[]>;

export interface RunPerspectiveInput {
  name: PerspectiveName;
  topic: ResearchTopicRef;
  profile: CreatorProfile | null;
  broker: ResearchBroker;
  /** 对标视角读拆解卡的口子；缺省 listPatternCards（只读，绝不写） */
  patternStore?: PatternLister;
  engineConfig?: EngineConfig;
  dataDir?: string;
  runLoopImpl?: typeof runLoop;
  /** 墙钟上限，缺省 4 分钟 */
  deadlineMs?: number;
}

export type PerspectiveErrorCode = "deadline" | "no_submit" | "invalid_output" | "engine_failed";

export type PerspectiveRunResult =
  | { status: "succeeded"; output: PerspectiveOutput; tokensUsed: number }
  | { status: "failed"; errorCode: PerspectiveErrorCode; reason: string };

// ─── prompt 组装 ─────────────────────────────────────────────────────────────

function buildSystemPrompt(name: PerspectiveName): string {
  const book = PERSPECTIVE_TASK_BOOKS[name];
  return [
    INJECTION_NOTICE,
    "",
    `你是这位创作者内容团队里的调研员，本轮只负责一个视角：**${book.label}**。`,
    ...book.mission,
    "",
    "检索纪律：search 拿候选（返回 s 开头的来源 id），read_page 打开页面（返回 p 开头的来源 id）。",
    "证据只能引用 p 开头的来源——搜索摘要不算原文。配额有限，工具会明确告诉你还能不能用；",
    "配额用尽就用手上的材料收束，不要反复重试。",
    "",
    `产出：调用 submit_perspective 一次交齐。insights ${INSIGHT_MIN}-${INSIGHT_MAX} 条，每条必须带至少一个来源 id；`,
    "evidence 是逐字原文摘抄（可空）；asset_picks 只能填工具给过的图片 id；",
    "gaps 记下你没查到、被配额挡住、或存疑的地方——留白比编造有价值。",
    "除工具调用外不要输出分析文字。",
  ].join("\n");
}

/** 可信上下文：创作者档案与选题来自我们自己的库，与 relevance/triage 同口径取字段 */
function buildTrustedContext(input: RunPerspectiveInput): string {
  const lines = [`创作者定位：${input.profile?.industry?.trim() || "(未填写)"}`];
  // 受众画像三层只对受众视角展开——其余视角要的是选题本身，画像会稀释注意力
  const persona = personaSummary(input.profile?.audiencePersona, {
    allTiers: input.name === "audience",
  });
  if (persona) lines.push(`受众画像：${persona}`);
  return lines.join("\n");
}

export function buildPerspectiveUserMessage(input: RunPerspectiveInput): string {
  const book = PERSPECTIVE_TASK_BOOKS[input.name];
  return [
    buildTrustedContext(input),
    "",
    "本次要调研的选题（来自我们自己的灵感库，可信）：",
    `标题：${clampChars(input.topic.title.trim(), TOPIC_TITLE_MAX_CHARS) || "(无标题)"}`,
    `描述：${clampChars(input.topic.description.trim(), TOPIC_DESC_MAX_CHARS) || "(无描述)"}`,
    "",
    `你的视角：${book.label}。先想清楚要查什么再动手检索，最后调用 submit_perspective 交付。`,
  ].join("\n");
}

// ─── 工具带 ──────────────────────────────────────────────────────────────────

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 工具带：出网两把 + 对标视角的只读拆解卡；实现与消毒纪律在 research-tools.ts */
function buildToolBelt(
  input: RunPerspectiveInput,
  state: RunState,
  capture: SubmitCapture<PerspectiveOutput>,
): LoopTool[] {
  const handle = input.broker.forPerspective(input.name);
  return [
    buildSearchTool(handle, state),
    buildReadPageTool(handle, state),
    ...(input.name === "benchmark"
      ? [
          buildListPatternsTool({
            lister: input.patternStore ?? (() => listPatternCards({}, input.dataDir)),
            topicText: `${input.topic.title} ${input.topic.description}`,
          }),
        ]
      : []),
    buildSubmitTool(capture, input.name, input.broker),
  ];
}

// ─── submit_perspective：校验（代码侧，模型说了不算） ────────────────────────

function readInsights(raw: unknown, broker: ResearchBroker, problems: string[]) {
  const insights: PerspectiveOutput["insights"] = [];
  for (const [i, item] of objList(raw).slice(0, INSIGHT_MAX).entries()) {
    const text = str(item.text);
    const sourceIds = strList(item.source_ids ?? item.sourceIds);
    if (!text) {
      problems.push(`insights[${i}].text 为空`);
      continue;
    }
    if (sourceIds.length === 0) {
      problems.push(`insights[${i}] 缺 source_ids：每条洞察都必须挂在检索到的来源上`);
      continue;
    }
    const unknownIds = sourceIds.filter((id) => !broker.getSource(id));
    if (unknownIds.length) {
      problems.push(
        `insights[${i}] 引用了未登记的来源 id：${unknownIds.join("、")}——只能用 search / read_page 返回过的 id`,
      );
      continue;
    }
    insights.push({ text, sourceIds });
  }
  if (insights.length < INSIGHT_MIN) {
    problems.push(`合法洞察需 ≥${INSIGHT_MIN} 条（每条带有效来源），当前 ${insights.length} 条`);
  }
  return insights;
}

/** 引文逐条回原页校验，broker 的 reason 原样进修复轮——它写的就是给模型看的人话 */
function readEvidence(raw: unknown, broker: ResearchBroker, problems: string[]) {
  const evidence: PerspectiveOutput["evidence"] = [];
  for (const [i, item] of objList(raw).slice(0, EVIDENCE_MAX).entries()) {
    const claim = str(item.claim);
    const sourceId = str(item.source_id ?? item.sourceId);
    const quote = str(item.quote);
    if (!claim || !sourceId || !quote) {
      problems.push(`evidence[${i}] 需要 claim / source_id / quote 三项都有`);
      continue;
    }
    const check = broker.validateQuote(sourceId, quote);
    if (!check.ok) {
      problems.push(`evidence[${i}]（${sourceId}）：${check.reason}`);
      continue;
    }
    evidence.push({ claim, sourceId, quote });
  }
  return evidence;
}

/** assetId 必须是 broker 登记过的——模型转述的图片 URL 一律不认（§3） */
function readAssetPicks(raw: unknown, broker: ResearchBroker, problems: string[]) {
  const picks: PerspectiveOutput["assetPicks"] = [];
  for (const [i, item] of objList(raw).slice(0, ASSET_PICK_MAX).entries()) {
    const assetId = str(item.asset_id ?? item.assetId);
    const caption = str(item.caption);
    if (!assetId) {
      problems.push(`asset_picks[${i}] 缺 asset_id`);
      continue;
    }
    if (!broker.getAssetCandidate(assetId)) {
      problems.push(`asset_picks[${i}] 的 asset_id「${assetId}」不存在——只能选 read_page 列出过的图片 id`);
      continue;
    }
    picks.push({ assetId, caption: caption || "(未命名)" });
  }
  return picks;
}

function validatePerspective(
  args: Record<string, unknown>,
  name: PerspectiveName,
  broker: ResearchBroker,
): Checked<PerspectiveOutput> {
  const problems: string[] = [];
  const insights = readInsights(args.insights, broker, problems);
  const evidence = readEvidence(args.evidence, broker, problems);
  const assetPicks = readAssetPicks(args.asset_picks ?? args.assetPicks, broker, problems);
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    value: { name, insights, evidence, assetPicks, gaps: strList(args.gaps) },
  };
}

const SUBMIT_TOOL_NAME = "submit_perspective";

/** 工具参数 schema（声明式数据，与校验逻辑分开放） */
const SUBMIT_SCHEMA = {
  type: "object",
  properties: {
    insights: {
      type: "array",
      description: `${INSIGHT_MIN}-${INSIGHT_MAX} 条洞察，每条必须带来源 id`,
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "一条具体洞察，不要泛泛而谈" },
          source_ids: {
            type: "array",
            items: { type: "string" },
            description: "支撑它的来源 id，至少一个",
          },
        },
        required: ["text", "source_ids"],
      },
    },
    evidence: {
      type: "array",
      description: `0-${EVIDENCE_MAX} 条硬证据，quote 必须是该页逐字原文`,
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "这条引文证明了什么" },
          source_id: { type: "string", description: "read_page 返回的 p 开头 id" },
          quote: { type: "string", description: "从 read_page 显示正文里逐字复制的 15~60 字短句，不要改写" },
        },
        required: ["claim", "source_id", "quote"],
      },
    },
    asset_picks: {
      type: "array",
      description: `0-${ASSET_PICK_MAX} 张真实图片候选，只能用工具给过的图片 id`,
      items: {
        type: "object",
        properties: {
          asset_id: { type: "string", description: "read_page 列出的 a 开头 id" },
          caption: { type: "string", description: "这张图能用来说明什么" },
        },
        required: ["asset_id", "caption"],
      },
    },
    gaps: {
      type: "array",
      items: { type: "string" },
      description: "没查到 / 被配额挡住 / 存疑的地方，如实写",
    },
  },
  required: ["insights", "gaps"],
};

function buildSubmitTool(
  capture: SubmitCapture<PerspectiveOutput>,
  name: PerspectiveName,
  broker: ResearchBroker,
): LoopTool {
  return {
    name: SUBMIT_TOOL_NAME,
    description: "提交本视角的调研结果。一次交齐，交完即结束。",
    parameters: SUBMIT_SCHEMA,
    execute(args) {
      return captureSubmit(capture, validatePerspective(args, name, broker), SUBMIT_TOOL_NAME);
    },
  };
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

async function resolveConfig(input: RunPerspectiveInput): Promise<EngineConfig> {
  if (input.engineConfig) return input.engineConfig;
  return loadEngineConfig(input.dataDir);
}

const DEADLINE = Symbol("deadline");
type LoopOutcome = { ok: true; result: LoopResult } | { ok: false; error: unknown };

/**
 * 墙钟竞速。**取舍**：runLoop 不可中断，到点只能丢弃结果——底层那轮请求会自然跑完
 * （token 上限是它的最终兜底）。同时把本路标记为已弃，工具立刻停止继续消耗四路共享的
 * broker 配额；僵尸视角偷额度才是超时真正的代价。
 */
async function raceDeadline(
  work: Promise<LoopOutcome>,
  ms: number,
  state: RunState,
): Promise<LoopOutcome | typeof DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => {
      state.abandoned = true;
      resolve(DEADLINE);
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** 回执优先级：拿到合法载荷 > 压根没提交 > 提交了但修复轮耗尽 */
function settle(
  capture: SubmitCapture<PerspectiveOutput>,
  result: LoopResult,
): PerspectiveRunResult {
  if (capture.payload) {
    return { status: "succeeded", output: capture.payload, tokensUsed: result.totalTokens };
  }
  if (capture.attempts === 0) {
    return {
      status: "failed",
      errorCode: "no_submit",
      reason: `模型没有调用 ${SUBMIT_TOOL_NAME}（loop ${result.stopReason}，turns=${result.turns}）`,
    };
  }
  return { status: "failed", errorCode: "invalid_output", reason: capture.problems.join("；") };
}

/**
 * 跑一个视角。**不抛**——任何失败都收敛成 `{status:"failed", errorCode}`，
 * 因为四路是 allSettled 并行，一路的故障只该让这一路缺席，不该带走整个 job。
 */
export async function runPerspective(input: RunPerspectiveInput): Promise<PerspectiveRunResult> {
  let config: EngineConfig;
  try {
    config = await resolveConfig(input);
  } catch (err) {
    return { status: "failed", errorCode: "engine_failed", reason: `引擎未配置：${errText(err)}` };
  }
  const scout = resolveEngineRoute(config, "scout", config.strongModel);
  const state: RunState = { abandoned: false };
  const capture = newCapture<PerspectiveOutput>();
  const deadlineMs = input.deadlineMs ?? DEFAULT_PERSPECTIVE_DEADLINE_MS;

  // work 永不 reject：race 之后不会有掉在地上的 rejection
  const work: Promise<LoopOutcome> = (input.runLoopImpl ?? runLoop)(scout.config, {
    model: scout.model,
    systemPrompt: buildSystemPrompt(input.name),
    userMessage: buildPerspectiveUserMessage(input),
    tools: buildToolBelt(input, state, capture),
    maxTurns: MAX_TURNS,
    maxTotalTokens: MAX_TOTAL_TOKENS,
    logMeta: { agent: "scout" },
  }).then(
    (result) => ({ ok: true as const, result }),
    (error) => ({ ok: false as const, error }),
  );

  const raced = await raceDeadline(work, deadlineMs, state);
  if (raced === DEADLINE) {
    return {
      status: "failed",
      errorCode: "deadline",
      reason: `视角超时（${Math.round(deadlineMs / 1000)} 秒），本路结果作废`,
    };
  }
  if (!raced.ok) {
    return { status: "failed", errorCode: "engine_failed", reason: `引擎调用失败：${errText(raced.error)}` };
  }
  return settle(capture, raced.result);
}
