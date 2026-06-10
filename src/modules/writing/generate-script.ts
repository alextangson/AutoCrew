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
import { getPack, DEFAULT_PACK_ID } from "../packs/index.js";
import { loadProfile } from "../profile/creator-profile.js";
import { buildScriptPrompts } from "./script-prompt.js";
import type { ScriptRequest } from "./script-prompt.js";
import { humanizeZh } from "../humanizer/zh.js";
import { scanText } from "../filter/sensitive-words.js";
import { saveContent } from "../../storage/local-store.js";

export type { ScriptRequest };

export interface GeneratedScript {
  contentId: string;
  title: string;
  /** hook + 正文 + CTA 组装后、humanize 后的最终文本 */
  body: string;
  hashtags: string[];
  /** 违禁词命中（不阻断存稿，透出给上层） */
  violations: string[];
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

/** Build the submit_script LoopTool; the captured variable is mutated on success. */
function buildSubmitTool(captured: { payload: SubmitPayload | null }): LoopTool {
  return {
    name: "submit_script",
    description: "提交最终口播脚本。所有字段必填。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "脚本标题" },
        hook: { type: "string", description: "开篇钩子" },
        body: { type: "string", description: "正文内容" },
        cta: { type: "string", description: "行动号召结尾" },
        hashtags: { type: "array", items: { type: "string" }, description: "话题标签列表" },
      },
      required: REQUIRED_FIELDS,
    },
    execute(args) {
      const result = validateSubmitArgs(args);
      if (!result.ok) return result.error;
      // Last valid submission wins — a corrected resubmission replaces the earlier capture.
      captured.payload = result.payload;
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
    Promise.resolve(getPack(DEFAULT_PACK_ID)),
    loadProfile(dataDir),
  ]);

  const { system, user } = buildScriptPrompts(pack, profile, req);

  const captured: { payload: SubmitPayload | null } = { payload: null };
  const submitTool = buildSubmitTool(captured);

  const loopFn = deps?.runLoopImpl ?? runLoop;
  const result: LoopResult = await loopFn(config, {
    model: config.strongModel,
    systemPrompt: system,
    userMessage: user,
    tools: [submitTool],
    maxTurns: 4,
  });

  if (!captured.payload) {
    throw new Error(
      `脚本生成失败：模型未调用 submit_script 工具提交脚本（loop 状态：${result.stopReason}，turns=${result.turns}）`,
    );
  }

  return finalizeScript(captured.payload, req, result.totalTokens, dataDir);
}

/** 后处理：组装 → humanize → 违禁词扫描 → 存稿（draft_ready，同现有写作流）。 */
async function finalizeScript(
  payload: SubmitPayload,
  req: ScriptRequest,
  tokensUsed: number,
  dataDir?: string,
): Promise<GeneratedScript> {
  const { title, hook, body: bodyText, cta, hashtags } = payload;
  const assembled = `${hook}\n\n${bodyText}\n\n${cta}`;
  const { humanizedText } = humanizeZh({ text: assembled });

  const scanResult = await scanText(humanizedText, req.platform, dataDir);
  const violations = scanResult.hits.map((h) => h.word);

  const content = await saveContent(
    {
      title,
      body: humanizedText,
      platform: req.platform,
      status: "draft_ready",
      tags: [],
      hashtags,
    },
    dataDir,
  );

  return {
    contentId: content.id,
    title,
    body: humanizedText,
    hashtags,
    violations,
    tokensUsed,
  };
}
