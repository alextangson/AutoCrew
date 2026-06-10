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
import type { EngineConfig } from "../../engine/config.js";
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

const REQUIRED_FIELDS: (keyof SubmitPayload)[] = ["title", "hook", "body", "cta", "hashtags"];

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
      for (const field of REQUIRED_FIELDS) {
        const val = args[field];
        const empty =
          val === undefined ||
          val === null ||
          val === "" ||
          (Array.isArray(val) && val.length === 0);
        if (empty) {
          return `Error: 缺少字段 ${field}，请补全后重新调用 submit_script`;
        }
      }
      captured.payload = args as unknown as SubmitPayload;
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
  const result: LoopResult = await loopFn(config as EngineConfig, {
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

  const { title, hook, body: bodyText, cta, hashtags } = captured.payload;
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
    tokensUsed: result.totalTokens,
  };
}
