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
import { loadEngineConfig } from "../../engine/config.js";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool, LoopResult } from "../../engine/loop.js";
import { getPack, getPackForPlatform } from "../packs/index.js";
import type { QualityGateSpec } from "../packs/pack-schema.js";
import { loadProfile } from "../profile/creator-profile.js";
import { buildScriptPrompts } from "./script-prompt.js";
import type { ScriptRequest } from "./script-prompt.js";
import { runQualityGate, formatGateFeedback } from "./quality-gate.js";
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

export async function generateScript(
  req: ScriptRequest,
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<GeneratedScript> {
  const [config, pack, profile] = await Promise.all([
    loadEngineConfig(dataDir),
    Promise.resolve(req.packId ? getPack(req.packId) : getPackForPlatform(req.platform)),
    loadProfile(dataDir),
  ]);

  const { system, user } = buildScriptPrompts(pack, profile, req);

  // 防呆 P1（IA v4.2 失败边界）:分钟级长任务先落占位稿——中途死不许蒸发。
  // 占位卡立刻出现在看板「在写」列;HTTP 断开/页面刷新都不影响它的存在。
  const placeholder = await saveContent(
    {
      title: `［生成中］${req.topic.slice(0, 40)}`,
      body: "",
      platform: req.platform,
      status: "drafting",
      tags: [],
      hashtags: [],
    },
    dataDir,
  );

  const captured: Captured = { payload: null, gateFailures: [] };
  const gate = pack.qualityGate;
  const submitTool = buildSubmitTool(captured, gate);

  try {
    const loopFn = deps?.runLoopImpl ?? runLoop;
    const result: LoopResult = await loopFn(config, {
      model: config.strongModel,
      systemPrompt: system,
      userMessage: user,
      tools: [submitTool],
      // Gate 修复轮需要额外回合与 token 预算（5000+ 字长文 × 最多 1+N 稿）
      maxTurns: gate ? 4 + (gate.maxRepairRounds ?? 2) * 2 : 4,
      maxTotalTokens: gate ? 80000 : undefined,
    });

    if (!captured.payload) {
      throw new Error(
        `脚本生成失败：模型未调用 submit_script 工具提交脚本（loop 状态：${result.stopReason}，turns=${result.turns}）`,
      );
    }

    const rulesApplied = profile ? rulesForPlatform(profile, req.platform).length : 0;
    return await finalizeScript(captured.payload, req, result.totalTokens, captured.gateFailures, rulesApplied, placeholder.id, dataDir);
  } catch (err) {
    // 失败留痕:占位稿标注中断原因（best-effort,不吞原错误）——UI 显示徽章与重试入口
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await updateContent(
        placeholder.id,
        { title: `［生成中断］${req.topic.slice(0, 40)}`, lastError: msg },
        dataDir,
      );
    } catch { /* 留痕失败不掩盖原错误 */ }
    throw err;
  }
}

/** 后处理：组装 → humanize → 违禁词扫描 → 占位稿转正（draft_ready，同现有写作流）。 */
async function finalizeScript(
  payload: SubmitPayload,
  req: ScriptRequest,
  tokensUsed: number,
  gateFailures: GateFailure[],
  rulesApplied: number,
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
      hashtags: cleanHashtags,
      lastError: null,
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
