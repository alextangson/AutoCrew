/**
 * 生成管线 — 进程内口播脚本生成（PRD §5 内层 loop）
 *
 * 流程：loadEngineConfig + getPack + loadProfile → buildScriptPrompts
 *   → runLoop（submit_script 工具作为结构化输出通道）
 *   → humanizeZh → scanText（违禁词）→ saveContent（draft_ready）
 *
 * submit_script 工具的 execute 闭包捕获 payload；缺字段时返回错误消息让
 * 模型自纠，而不是抛出（保持 loop 继续）。
 */
import { loadEngineConfig, resolveEngineRoute } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool, LoopResult } from "../../engine/loop.js";
import { getPack, getPackForPlatform } from "../packs/index.js";
import type { QualityGateSpec } from "../packs/pack-schema.js";
import { loadProfile } from "../profile/creator-profile.js";
import { recentContrastPairs } from "../learnings/diff-tracker.js";
import { buildScriptPrompts } from "./script-prompt.js";
import type { ScriptRequest } from "./script-prompt.js";
import { selectPatternsForScript } from "../patterns/pattern-select.js";
import type { PatternCard } from "../patterns/pattern-store.js";
import { runQualityGate, formatGateFeedback, resolveQualityGate } from "./quality-gate.js";
import type { GateFailure } from "./quality-gate.js";
import { humanizeZh } from "../humanizer/zh.js";
import { scanText } from "../filter/sensitive-words.js";
import { saveContent, updateContent } from "../../storage/local-store.js";
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
  tokensUsed: number;
}

interface SubmitPayload {
  title: string;
  hook: string;
  body: string;
  cta: string;
  hashtags: string[];
}

const TEXT_FIELDS = ["title", "hook", "body", "cta"] as const;
const REQUIRED_FIELDS: (keyof SubmitPayload)[] = [...TEXT_FIELDS, "hashtags"];

function missingField(field: string): string {
  return `Error: 缺少字段 ${field}，请补全后重新调用 submit_script`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

type SubmitValidation = { ok: true; payload: SubmitPayload } | { ok: false; error: string };

/** LLM 输出是不可信边界：缺失/空之外还必须校验类型，否则坏数据存进稿件后才爆。 */
function validateSubmitArgs(args: Record<string, unknown>): SubmitValidation {
  const text: Record<string, string> = {};
  for (const field of TEXT_FIELDS) {
    const val = args[field];
    if (val === undefined || val === null) return { ok: false, error: missingField(field) };
    if (typeof val !== "string") {
      return { ok: false, error: `Error: 字段 ${field} 应为字符串，请修正后重新调用 submit_script` };
    }
    if (val.trim() === "") return { ok: false, error: missingField(field) };
    text[field] = val;
  }
  const hashtags = args.hashtags;
  if (hashtags === undefined || hashtags === null) return { ok: false, error: missingField("hashtags") };
  if (!isStringArray(hashtags)) {
    return { ok: false, error: "Error: 字段 hashtags 应为字符串数组，请修正后重新调用 submit_script" };
  }
  if (hashtags.length === 0) return { ok: false, error: missingField("hashtags") };
  return {
    ok: true,
    payload: { title: text.title, hook: text.hook, body: text.body, cta: text.cta, hashtags },
  };
}

interface Captured {
  payload: SubmitPayload | null;
  gateFailures: GateFailure[];
}

/**
 * Build the submit_script LoopTool; the captured variable is mutated on success.
 * 有 gate 时：字段校验通过后跑 Quality Gate，FAIL 且修复轮未耗尽 → 返回修复指令
 * 打回（复用模型自纠通道）；每稿都先落 captured——loop 提前终止时最后一稿仍可用，
 * 残余 FAIL 经 gateFailures 透出（禁止静默失败）。
 */
function buildSubmitTool(captured: Captured, gate?: QualityGateSpec): LoopTool {
  let repairRounds = 0;
  return {
    name: "submit_script",
    description: "提交最终成稿。所有字段必填。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "标题" },
        hook: { type: "string", description: "开篇钩子" },
        body: { type: "string", description: "正文内容" },
        cta: { type: "string", description: "行动号召/引导语结尾" },
        hashtags: { type: "array", items: { type: "string" }, description: "话题标签/关键词列表" },
      },
      required: REQUIRED_FIELDS,
    },
    execute(args) {
      const result = validateSubmitArgs(args);
      if (!result.ok) return result.error;
      // Last valid submission wins — a corrected resubmission replaces the earlier capture.
      captured.payload = result.payload;
      if (gate) {
        const failures = runQualityGate(gate, result.payload);
        captured.gateFailures = failures;
        if (failures.length > 0 && repairRounds < (gate.maxRepairRounds ?? 2)) {
          repairRounds += 1;
          return formatGateFeedback(failures);
        }
      }
      return "已收到脚本";
    },
  };
}

/** 生成占位稿标题哨兵——区分「生成占位稿」与手工存的 drafting 稿(content-save 允许)。
 *  renderer(board/workbench.js)按同字面量正则识别,改动需同步。 */
export const GENERATING_TITLE_PREFIX = "［生成中］";
export const INTERRUPTED_TITLE_PREFIX = "［生成中断］";

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
    },
    dataDir,
  );
  return placeholder.id;
}

/** 选卡（usePatterns:false 显式关闭时连读都不读）。选题标题与角度都在 req.topic 这一串自由文本里 */
function selectPatterns(req: ScriptRequest, dataDir?: string): Promise<PatternCard[]> {
  if (req.usePatterns === false) return Promise.resolve([]);
  return selectPatternsForScript({ platform: req.platform, topicText: req.topic }, dataDir);
}

/** 执行体:loop → 占位稿转正;失败标〔生成中断〕+ lastError 后原样抛出 */
async function runGeneration(
  placeholderId: string,
  req: ScriptRequest,
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
  runId?: string,
): Promise<GeneratedScript> {
  const [config, pack, profile, contrastPairs, patterns] = await Promise.all([
    loadEngineConfig(dataDir),
    Promise.resolve(req.packId ? getPack(req.packId) : getPackForPlatform(req.platform)),
    loadProfile(dataDir),
    // 改稿对比对(V5.7 活人感):读取失败不阻断写稿——样例是增强,不是依赖
    recentContrastPairs(3, dataDir).catch(() => []),
    // 对标拆解卡(收件箱 §3.5):平台+主题相关才选,无匹配即空数组。
    // 这里**不加 catch**:patterns 库不存在是正常空态(store 已按 ENOENT 返回 []),
    // 其余读故障必须炸出来——静默降级会让「卡怎么没生效」查无可查。
    selectPatterns(req, dataDir),
  ]);
  const usedPatternIds = patterns.map((card) => card.id);

  const { system, user } = buildScriptPrompts(pack, profile, req, { contrastPairs, patterns });
  const writer = resolveEngineRoute(config, "writer", config.strongModel);
  const captured: Captured = { payload: null, gateFailures: [] };
  const gate = resolveQualityGate(pack, req.platform);
  const submitTool = buildSubmitTool(captured, gate);

  try {
    const loopFn = deps?.runLoopImpl ?? runLoop;
    const result: LoopResult = await loopFn(writer.config, {
      model: writer.model,
      systemPrompt: system,
      userMessage: user,
      tools: [submitTool],
      // Gate 修复轮需要额外回合与 token 预算（整稿 × 最多 1+N 稿）
      maxTurns: gate ? 4 + (gate.maxRepairRounds ?? 2) * 2 : 4,
      maxTotalTokens: gate ? 80000 : undefined,
      // usedPatternIds 进 run-log 元数据(§3.5 使用追踪):无卡时字段不出现,日志口径不变
      logMeta: {
        ...(runId ? { runId } : {}),
        agent: "writer",
        ...(usedPatternIds.length > 0 ? { usedPatternIds } : {}),
      },
    });

    if (!captured.payload) {
      throw new Error(
        `脚本生成失败：模型未调用 submit_script 工具提交脚本（loop 状态：${result.stopReason}，turns=${result.turns}）`,
      );
    }

    const rulesApplied = profile ? rulesForPlatform(profile, req.platform).length : 0;
    return await finalizeScript(captured.payload, req, result.totalTokens, captured.gateFailures, rulesApplied, usedPatternIds, placeholderId, dataDir);
  } catch (err) {
    // 失败留痕:占位稿标注中断原因（best-effort,不吞原错误）——UI 显示徽章与重试入口
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await updateContent(
        placeholderId,
        { title: `${INTERRUPTED_TITLE_PREFIX}${req.topic.slice(0, 40)}`, lastError: msg },
        dataDir,
      );
    } catch { /* 留痕失败不掩盖原错误 */ }
    throw err;
  }
}

/** 同步版（MCP 外部 agent 与测试用:调用方要等成稿） */
export async function generateScript(
  req: ScriptRequest,
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
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

/**
 * 后台化入口（契约 P1 工程项完全体）:提交即返回占位稿 id,生成在进程后台跑,
 * HTTP 请求/页面刷新与任务生命周期彻底解耦。进度经 onEvent 回调外发
 * （调用方注入 emitEngineEvent——modules 层不依赖 desktop 层）。
 */
export function startGenerateScript(
  req: ScriptRequest,
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop; onEvent?: (e: BackgroundGenEvent) => void },
): Promise<StartedGeneration> {
  const runId = `run-bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const emit = (e: BackgroundGenEvent) => { try { deps?.onEvent?.(e); } catch { /* 观测层吞错 */ } };

  return createPlaceholder(req, dataDir).then((contentId) => {
    const completion = (async () => {
      emit({ role: "writer", kind: "work", label: `编剧开写《${req.topic.slice(0, 24)}》`, contentId, runId });
      try {
        const result = await runGeneration(contentId, req, dataDir, deps, runId);
        emit({ role: "system", kind: "run_done", label: `《${result.title.slice(0, 24)}》写完,待审改`, contentId, runId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ role: "writer", kind: "run_failed", label: `编剧写稿中断：${msg.slice(0, 60)}`, contentId, runId });
      }
    })();
    return { contentId, runId, completion };
  });
}

/** 后处理：组装 → humanize → 违禁词扫描 → 占位稿转正（draft_ready，同现有写作流）。 */
async function finalizeScript(
  payload: SubmitPayload,
  req: ScriptRequest,
  tokensUsed: number,
  gateFailures: GateFailure[],
  rulesApplied: number,
  usedPatternIds: string[],
  placeholderId: string,
  dataDir?: string,
): Promise<GeneratedScript> {
  const { title, hook, body: bodyText, cta, hashtags } = payload;
  const assembled = `${hook}\n\n${bodyText}\n\n${cta}`;
  const { humanizedText } = humanizeZh({ text: assembled });

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
      // 归因落稿件元数据(§3.5):无卡时不写字段——没用卡的稿与改动前一字不差
      ...(usedPatternIds.length > 0 ? { usedPatternIds } : {}),
      _versionNote: "AI 完成初稿",
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
    gateFailures: gateFailures.map((f) => f.detail),
    rulesApplied,
    tokensUsed,
  };
}
