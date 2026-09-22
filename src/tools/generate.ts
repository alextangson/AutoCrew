/**
 * autocrew_generate — 进程内口播脚本生成工具（PRD §5 薄 loop 内层的宿主入口）。
 *
 * 调用生成管线（generate-script.ts），返回 {ok, data} 或 {ok, error}。
 * 引擎未配置的中文可执行提示必须原文透传，让用户知道如何修复。
 */
import { inspectWritingReadiness, writingContinueParams, writingReadinessFailure } from "./writing-readiness.js";
import { getDataDir } from "../storage/local-store.js";
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
  execution: Type.Optional(Type.Literal("engine", { description: "仅用户明确选择后台模型代写时传 engine；普通请求用 workflow prepare 后由宿主 writer 写" })),
  research_mode: Type.Optional(Type.Unsafe<"auto" | "provided" | "skip">({ type: "string", enum: ["auto", "provided", "skip"] })),
  research_reason: Type.Optional(Type.String({ description: "用户明确跳过研究的原因，skip 必填" })),
  skip_reason: Type.Optional(Type.String({ description: "用户明确不选立意的原因，不能由模型自行假定" })),
  research: Type.Optional(
    Type.String({ description: "Optional research material to inject into the prompt." }),
  ),
  direction: Type.Optional(
    Type.String({ description: "创作者明确指定的本稿角度；优先于选中的立意卡。" }),
  ),
  requirements: Type.Optional(
    Type.String({ description: "创作者本次完整写作要求：受众、提纲、必写/禁写、篇幅、口吻与修改反馈。补充立意，不要混入 research。" }),
  ),
  topic_id: Type.Optional(
    Type.String({
      description:
        "MCP 必填：已准备的选题 id。没有研究和立意时先 workflow prepare，不允许裸写。",
    }),
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
    gateFailures: string[];
    unverifiedNumbers: string[];
    blockedReason?: string;
    /** IA v4.2 §B5：本稿注入的个人规则数，draft 卡标注「越用越像你」 */
    rulesApplied: number;
    tokensUsed: number;
    writing_source: { kind: "engine" };
    review?: GeneratedScript["review"];
    quality_status: string;
    needs_attention: boolean;
  };
};

type GenerateFailure = { ok: false; error: string } & Record<string, unknown>;
type GenerateResult = GenerateSuccess | GenerateFailure;

// ─── Deps (for testability) ───────────────────────────────────────────────────

export interface GenerateDeps {
  generateScriptImpl?: (req: ScriptRequest, dataDir?: string) => Promise<GeneratedScript>;
}

/** A recovery step must preserve the same request, including user-supplied materials. */
function preparationHandoff(req: ScriptRequest): Record<string, unknown> {
  const continuation = writingContinueParams(req.topicId ?? "", req);
  if (req.topicId) return {
    continue_params: continuation,
    next_action: { tool: "autocrew_workflow", params: { ...continuation, action: "prepare" } },
  };
  delete continuation.topic_id;
  return {
    continue_params: continuation,
    next_action: {
      tool: "autocrew_topic",
      params: { action: "create", title: req.topic, description: req.topic, tags: [] },
    },
    note: "先建立选题；将返回的 topic.id 填入 topic_id，再携带全部 continue_params 调用 workflow prepare。保留原始方向、要求与已有材料，不重新猜测调研方式。",
  };
}

/** Saving a draft or passing semantic review alone does not clear other checks. */
function generatedQualityStatus(result: GeneratedScript): string {
  if (result.needsEvidence) return "blocked";
  const review = result.review;
  if (!review || review.status === "skipped" || review.status === "stale") return "unreviewed";
  if (review.status === "failed" || review.issues.some((issue) => issue.severity === "blocker")) return "issues_remaining";
  const hasNotes = review.issues.length > 0 || (result.gateFailures?.length ?? 0) > 0
    || (result.violations?.length ?? 0) > 0 || (result.unverifiedNumbers?.length ?? 0) > 0;
  return hasNotes ? "passed_with_notes" : "passed";
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

  const dataDir = (params._dataDir as string) || undefined;

  const req: ScriptRequest = {
    topic: topic.trim(),
    platform: platformRaw,
    // 知识库检索已下沉到生成管线(runGeneration)统一做——这里再检索会让 MCP 路径双份注入
    research: (params.research as string) || undefined,
    direction: typeof params.direction === "string" ? params.direction.trim() || undefined : undefined,
    requirements: typeof params.requirements === "string" ? params.requirements.trim() || undefined : undefined,
    researchMode: params.research_mode as ScriptRequest["researchMode"],
    researchReason: typeof params.research_reason === "string" ? params.research_reason.trim() || undefined : undefined,
    angleSkipReason: typeof params.skip_reason === "string" ? params.skip_reason.trim() || undefined : undefined,
    // 简报注入与选题血缘都挂在 topicId 上——空串视为未提供，口径同桌面 IPC(ipc.ts)
    topicId: typeof params.topic_id === "string" ? params.topic_id.trim() || undefined : undefined,
  };

  // The MCP host must not silently replace itself with a configured engine.
  if (typeof params._host === "string") {
    if (params.execution !== "engine") return {
      ok: false, code: "host_writer_default",
      error: "默认由当前宿主写作。先用 workflow prepare 准备材料与立意，再走 writer；仅用户明确要后台代写时传 execution=engine。",
      ...preparationHandoff(req),
    };
    if (!req.topicId) return {
      ok: false, code: "topic_required",
      error: "后台代写也需要已准备的 topic_id；先建立选题并调用 workflow prepare，准备完成后保留 execution=engine 继续后台代写。",
      ...preparationHandoff(req),
      requested_execution: "engine",
    };
    const preparation = await inspectWritingReadiness(req.topicId, req, getDataDir(dataDir));
    if (!preparation.ready) return writingReadinessFailure(preparation);
  }
  const generateFn = deps.generateScriptImpl ?? generateScript;

  try {
    const result = await generateFn(req, dataDir);
    const qualityStatus = generatedQualityStatus(result);
    return {
      ok: true,
      data: {
        contentId: result.contentId,
        title: result.title,
        body: result.body,
        hashtags: result.hashtags,
        violations: result.violations,
        gateFailures: result.gateFailures ?? [],
        unverifiedNumbers: result.unverifiedNumbers ?? [],
        ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
        rulesApplied: result.rulesApplied ?? 0,
        tokensUsed: result.tokensUsed,
        writing_source: { kind: "engine" },
        review: result.review,
        quality_status: qualityStatus,
        needs_attention: qualityStatus !== "passed",
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
