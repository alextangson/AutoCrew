/**
 * autocrew_generate — 进程内口播脚本生成工具（PRD §5 薄 loop 内层的宿主入口）。
 *
 * 调用生成管线（generate-script.ts），返回 {ok, data} 或 {ok, error}。
 * 引擎未配置的中文可执行提示必须原文透传，让用户知道如何修复。
 */
import { Type } from "@sinclair/typebox";
import { generateScript } from "../modules/writing/generate-script.js";
import type { GeneratedScript, ScriptRequest } from "../modules/writing/generate-script.js";
import type { ClipboardPlatform } from "../modules/publish/clipboard-publisher.js";

// ─── Schema ───────────────────────────────────────────────────────────────────

export const generateSchema = Type.Object({
  action: Type.Unsafe<"script">({
    type: "string",
    enum: ["script"],
    description: "Generation action. Currently only 'script' is supported.",
  }),
  topic: Type.Optional(
    Type.String({ description: "Script topic (required for action=script)." }),
  ),
  platform: Type.Optional(
    Type.String({
      description:
        "Target platform (required for action=script). Valid values: douyin | xiaohongshu | wechat_mp | wechat_video | bilibili.",
    }),
  ),
  research: Type.Optional(
    Type.String({ description: "Optional research material to inject into the prompt." }),
  ),
});

// ─── Valid platforms ──────────────────────────────────────────────────────────

const VALID_PLATFORMS: ClipboardPlatform[] = [
  "douyin",
  "xiaohongshu",
  "wechat_mp",
  "wechat_video",
  "bilibili",
];

function isValidPlatform(p: string): p is ClipboardPlatform {
  return (VALID_PLATFORMS as string[]).includes(p);
}

// ─── Result types ─────────────────────────────────────────────────────────────

type GenerateSuccess = {
  ok: true;
  data: {
    contentId: string;
    title: string;
    body: string;
    hashtags: string[];
    violations: string[];
    tokensUsed: number;
  };
};

type GenerateFailure = { ok: false; error: string };
type GenerateResult = GenerateSuccess | GenerateFailure;

// ─── Deps (for testability) ───────────────────────────────────────────────────

export interface GenerateDeps {
  generateScriptImpl?: (req: ScriptRequest, dataDir?: string) => Promise<GeneratedScript>;
}

// ─── Core execute ─────────────────────────────────────────────────────────────

export async function executeGenerate(
  params: Record<string, unknown>,
  deps: GenerateDeps = {},
): Promise<GenerateResult> {
  const action = params.action as string;

  if (action !== "script") {
    return { ok: false, error: `未知 action：${action}。当前支持：script` };
  }

  const topic = params.topic as string | undefined;
  if (!topic || topic.trim() === "") {
    return { ok: false, error: "缺少必填参数 topic：请提供脚本选题" };
  }

  const platformRaw = params.platform as string | undefined;
  if (!platformRaw || platformRaw.trim() === "") {
    return {
      ok: false,
      error: `缺少必填参数 platform。有效值：${VALID_PLATFORMS.join(" | ")}`,
    };
  }

  if (!isValidPlatform(platformRaw)) {
    return {
      ok: false,
      error: `无效 platform "${platformRaw}"。有效值：${VALID_PLATFORMS.join(" | ")}`,
    };
  }

  const req: ScriptRequest = {
    topic: topic.trim(),
    platform: platformRaw,
    research: params.research as string | undefined,
  };

  const generateFn = deps.generateScriptImpl ?? generateScript;
  const dataDir = (params._dataDir as string) || undefined;

  try {
    const result = await generateFn(req, dataDir);
    return {
      ok: true,
      data: {
        contentId: result.contentId,
        title: result.title,
        body: result.body,
        hashtags: result.hashtags,
        violations: result.violations,
        tokensUsed: result.tokensUsed,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
