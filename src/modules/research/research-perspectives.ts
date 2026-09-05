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
 * 3. **剔条目不清零**（P1c §4.7）：首次提交按严格档打回，给模型一次改对的机会；此后
 *    只把不合格的**条目**剔掉，剩下 ≥1 条合法洞察就算成功，剔除原因记进 `partialProblems`。
 *    生产 9 份简报里 9 路失败有 7 路是 `invalid_output`（多半是几条引文没逐字对上），
 *    为几条坏引文把整路调研清零，代价远大于收下一份少几条的产出。
 *    只有一条合法洞察都不剩才判 `invalid_output`。
 * 4. **三层预算合围**：runLoop 的 maxTurns/token 是「下一轮前检查」的软上限，broker 配额是
 *    硬闸，墙钟 deadline 是最后一道。deadline 到点只能**丢弃结果**——runLoop 不可中断，
 *    底层那轮请求会自然跑完（token 上限兜底）；同时把本路标记为已弃，工具立即停止
 *    继续消耗**四路共享**的 broker 配额（这是弃标记存在的全部理由）。
 */
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import type { EngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopFallbackInfo, LoopResult, LoopTool } from "../../engine/loop.js";
import { listPatternCards } from "../patterns/pattern-store.js";
import type { PatternCard } from "../patterns/pattern-store.js";
import { personaSummary } from "../profile/creator-profile.js";
import type { CreatorProfile } from "../profile/creator-profile.js";
import type { ResearchBroker } from "./research-broker.js";
import type { PerspectiveName } from "./research-job-store.js";
import type { PerspectiveInference, PerspectiveOutput } from "./brief-store.js";
import { PERSONA_KEYS, type PersonaKey } from "./personas.js";
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
/** 剔除之后的底线：剩这么多条合法洞察就收下（§4.7「剔条目不清零」） */
const INSIGHT_MIN_PARTIAL = 1;
const INSIGHT_MAX = 6;
const EVIDENCE_MAX = 8;
const ASSET_PICK_MAX = 10;
/** 受众推断上限（§3.6）：无来源的东西给多了会顶掉有来源的材料 */
const INFERENCE_MAX = 6;

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
      "你还有一个别人没有的口子 inferences：**凭经验而非页面**得出的心理与行为判断——",
      "他们心里信的那个错的东西、会在哪一秒划走、嘴上说的和真做的差在哪——写进 inferences，",
      "不需要来源；但凡能摘到原文的材料仍然要走 insights / evidence，别拿推断顶替材料。",
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
  /** `partial` = 有条目被校验剔除（原因在 output.partialProblems）；这一路仍然算成功 */
  | {
      status: "succeeded";
      output: PerspectiveOutput;
      tokensUsed: number;
      partial: boolean;
      /** 这一路是备用端点顶完的（P2 spec §4.3）：落进 ResearchJob.usedFallback */
      usedFallback?: LoopFallbackInfo;
    }
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
    ...(name === "audience"
      ? [
          `inferences 是你**无来源的受众推断**（0-${INFERENCE_MAX} 条，可空）：说不出出处的心理与行为判断放这里，`,
          `每条尽量标 persona（${PERSONA_KEYS.join(" / ")}）。它明确不作证据，所以不要把查到的材料塞进来。`,
        ]
      : []),
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

/**
 * 剔除账本。两个桶的区别只在**首次提交要不要因此打回**：
 * - `problems`：条目本身不合格（缺来源、引文对不上、图片 id 不存在）。首次提交拿它去打回，
 *   让模型有一次改对的机会；再交就只剔条目。
 * - `notes`：模型没做错什么、代码单方面忽略的东西（非受众视角交了 inferences、超上限截断）。
 *   永远不打回——为一个没在 schema 里给它的字段烧修复轮是浪费。
 * 两桶最终都进 `partialProblems`，产出里看得见「这份是剔过的」。
 */
interface Drops {
  problems: string[];
  notes: string[];
}

function readInsights(raw: unknown, broker: ResearchBroker, drops: Drops) {
  const insights: PerspectiveOutput["insights"] = [];
  for (const [i, item] of objList(raw).slice(0, INSIGHT_MAX).entries()) {
    const text = str(item.text);
    const sourceIds = strList(item.source_ids ?? item.sourceIds);
    if (!text) {
      drops.problems.push(`insights[${i}].text 为空`);
      continue;
    }
    if (sourceIds.length === 0) {
      drops.problems.push(`insights[${i}] 缺 source_ids：每条洞察都必须挂在检索到的来源上`);
      continue;
    }
    const unknownIds = sourceIds.filter((id) => !broker.getSource(id));
    if (unknownIds.length) {
      drops.problems.push(
        `insights[${i}] 引用了未登记的来源 id：${unknownIds.join("、")}——只能用 search / read_page 返回过的 id`,
      );
      continue;
    }
    insights.push({ text, sourceIds });
  }
  return insights;
}

/** 引文逐条回原页校验，broker 的 reason 原样进修复轮——它写的就是给模型看的人话 */
function readEvidence(raw: unknown, broker: ResearchBroker, drops: Drops) {
  const evidence: PerspectiveOutput["evidence"] = [];
  for (const [i, item] of objList(raw).slice(0, EVIDENCE_MAX).entries()) {
    const claim = str(item.claim);
    const sourceId = str(item.source_id ?? item.sourceId);
    const quote = str(item.quote);
    if (!claim || !sourceId || !quote) {
      drops.problems.push(`evidence[${i}] 需要 claim / source_id / quote 三项都有`);
      continue;
    }
    const check = broker.validateQuote(sourceId, quote);
    if (!check.ok) {
      // 归属纠偏（2026-08-23 生产复盘）：失败引文里八成是**真引文记错了页**——引文能在
      // 别的已读页逐字找到，就纠正 sourceId 收下，不烧修复轮；全库都找不到才是转述/编造，打回。
      const relocated = broker.locateQuote(quote);
      if (relocated) {
        evidence.push({ claim, sourceId: relocated, quote });
        continue;
      }
      drops.problems.push(`evidence[${i}]（${sourceId}）：${check.reason}`);
      continue;
    }
    evidence.push({ claim, sourceId, quote });
  }
  return evidence;
}

/** assetId 必须是 broker 登记过的——模型转述的图片 URL 一律不认（§3） */
function readAssetPicks(raw: unknown, broker: ResearchBroker, drops: Drops) {
  const picks: PerspectiveOutput["assetPicks"] = [];
  for (const [i, item] of objList(raw).slice(0, ASSET_PICK_MAX).entries()) {
    const assetId = str(item.asset_id ?? item.assetId);
    const caption = str(item.caption);
    if (!assetId) {
      drops.problems.push(`asset_picks[${i}] 缺 asset_id`);
      continue;
    }
    if (!broker.getAssetCandidate(assetId)) {
      drops.problems.push(
        `asset_picks[${i}] 的 asset_id「${assetId}」不存在——只能选 read_page 列出过的图片 id`,
      );
      continue;
    }
    picks.push({ assetId, caption: caption || "(未命名)" });
  }
  return picks;
}

function isPersonaKey(value: string): value is PersonaKey {
  return (PERSONA_KEYS as string[]).includes(value);
}

/**
 * 受众推断（§3.6）：**只校非空与条数**，不校来源——它的全部价值就是那些没有出处的判断。
 * 其余视角交了就整块忽略并记 note：它们的 schema 里根本没有这个字段。
 */
function readInferences(raw: unknown, name: PerspectiveName, drops: Drops): PerspectiveInference[] {
  const items = objList(raw);
  if (items.length === 0) return [];
  if (name !== "audience") {
    drops.notes.push(`inferences 只有受众视角能产，本视角交的 ${items.length} 条无来源推断已忽略`);
    return [];
  }
  const out: PerspectiveInference[] = [];
  for (const [i, item] of items.slice(0, INFERENCE_MAX).entries()) {
    const text = str(item.text);
    if (!text) {
      drops.notes.push(`inferences[${i}].text 为空，已忽略`);
      continue;
    }
    const persona = str(item.persona);
    out.push({ text, ...(isPersonaKey(persona) ? { persona } : {}) });
  }
  if (items.length > INFERENCE_MAX) {
    drops.notes.push(`inferences 最多 ${INFERENCE_MAX} 条，多出的 ${items.length - INFERENCE_MAX} 条已截断`);
  }
  return out;
}

/**
 * 校验（代码侧，模型说了不算）。`strict` = 这是本路的**首次**提交：条目有问题就整份打回，
 * 让模型有一次改对的机会；之后的提交只剔条目，剩 ≥1 条合法洞察就收（§4.7）。
 */
function validatePerspective(
  args: Record<string, unknown>,
  name: PerspectiveName,
  broker: ResearchBroker,
  strict: boolean,
): Checked<PerspectiveOutput> {
  const drops: Drops = { problems: [], notes: [] };
  const insights = readInsights(args.insights, broker, drops);
  const evidence = readEvidence(args.evidence, broker, drops);
  const assetPicks = readAssetPicks(args.asset_picks ?? args.assetPicks, broker, drops);
  const inferences = readInferences(args.inferences, name, drops);
  const min = strict ? INSIGHT_MIN : INSIGHT_MIN_PARTIAL;
  if (insights.length < min) {
    return {
      ok: false,
      problems: [
        ...drops.problems,
        `合法洞察需 ≥${min} 条（每条带有效来源），当前 ${insights.length} 条`,
      ],
    };
  }
  if (strict && drops.problems.length) return { ok: false, problems: drops.problems };
  const partialProblems = [...drops.problems.map((p) => `已剔除：${p}`), ...drops.notes];
  return {
    ok: true,
    value: {
      name,
      insights,
      evidence,
      assetPicks,
      gaps: strList(args.gaps),
      ...(inferences.length > 0 ? { inferences } : {}),
      ...(partialProblems.length > 0 ? { partialProblems } : {}),
    },
  };
}

const SUBMIT_TOOL_NAME = "submit_perspective";

/** 受众专属：无来源推断（§3.6）。只挂给受众视角——别的视角看得见就会往里塞没查到的话 */
const INFERENCES_SCHEMA = {
  type: "array",
  description: `0-${INFERENCE_MAX} 条无来源的受众推断：凭经验的心理/行为判断，明确不作证据`,
  items: {
    type: "object",
    properties: {
      text: { type: "string", description: "一条具体的受众心理或行为判断" },
      persona: { type: "string", enum: [...PERSONA_KEYS], description: "针对哪个画像，说不准就不填" },
    },
    required: ["text"],
  },
};

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

function submitSchema(name: PerspectiveName): Record<string, unknown> {
  if (name !== "audience") return SUBMIT_SCHEMA;
  return {
    ...SUBMIT_SCHEMA,
    properties: { ...SUBMIT_SCHEMA.properties, inferences: INFERENCES_SCHEMA },
  };
}

function buildSubmitTool(
  capture: SubmitCapture<PerspectiveOutput>,
  name: PerspectiveName,
  broker: ResearchBroker,
): LoopTool {
  return {
    name: SUBMIT_TOOL_NAME,
    description: "提交本视角的调研结果。一次交齐，交完即结束。",
    parameters: submitSchema(name),
    execute(args) {
      // 首次提交走严格档（打回一次让它改对），之后只剔条目——判别位是「本工具此前被调用过没有」
      const strict = capture.attempts === 0;
      return captureSubmit(capture, validatePerspective(args, name, broker, strict), SUBMIT_TOOL_NAME);
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
    return {
      status: "succeeded",
      output: capture.payload,
      tokensUsed: result.totalTokens,
      partial: (capture.payload.partialProblems?.length ?? 0) > 0,
      ...(result.usedFallback ? { usedFallback: result.usedFallback } : {}),
    };
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
