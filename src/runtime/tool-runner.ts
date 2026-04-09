/**
 * ToolRunner — middleware pipeline for tool execution.
 *
 * Inspired by Claude Code's StreamingToolExecutor. Provides:
 * - Middleware chain (dataDir injection, config, error boundary, audit)
 * - Unified tool registration (eliminates copy-paste in index.ts)
 * - Pre/Post hook integration points
 */
import {
  type ToolContext,
  type AuditEntry,
  updateWorkspace,
  recordAudit,
  resolveGeminiKey,
  resolveGeminiModel,
  resolveGatewayUrl,
} from "./context.js";
import { type EventBus, createEvent } from "./events.js";
import { loadProfile, detectMissingInfo } from "../modules/profile/creator-profile.js";

// --- Types ---

export type ToolResult = Record<string, unknown> & { ok?: boolean; error?: string };
export type ToolExecuteFn = (params: Record<string, unknown>) => Promise<ToolResult>;
export type Middleware = (
  ctx: ToolContext,
  toolName: string,
  params: Record<string, unknown>,
  next: () => Promise<ToolResult>,
) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: ToolExecuteFn;
  /** Tool actions that require Pro (e.g. ["generate_ratios"]) */
  proActions?: string[];
  /** If true, inject _geminiApiKey and _geminiModel into params */
  needsGemini?: boolean;
  /** If true, this tool is exempt from onboarding gate (e.g. init, pro_status) */
  skipOnboardingGate?: boolean;
}

export interface ToolRunnerOptions {
  ctx: ToolContext;
  eventBus?: EventBus;
  middleware?: Middleware[];
}

// --- Built-in Middleware ---

/** Tools exempt from onboarding gate */
const ONBOARDING_EXEMPT_TOOLS = new Set([
  "autocrew_init",
  "autocrew_pro_status",
  "autocrew_status",
  "autocrew_memory",
]);

/** Block non-exempt tools if profile is incomplete or style not calibrated */
const onboardingGateMiddleware: Middleware = async (ctx, toolName, _params, next) => {
  // Skip for exempt tools
  if (ONBOARDING_EXEMPT_TOOLS.has(toolName)) return next();

  try {
    const profile = await loadProfile(ctx.dataDir);
    if (!profile) {
      return {
        ok: false,
        error: "onboarding_required",
        message: "⚠️ 首次使用 AutoCrew，需要先完成初始设置。",
        action_required: "请先调用 autocrew_init 初始化数据目录，然后通过对话收集用户的行业、平台、受众信息，保存到 creator-profile.json。完成后再调用 autocrew_pro_status 确认。",
        steps: [
          "1. 调用 autocrew_init 初始化",
          "2. 询问用户：你的行业/领域是什么？",
          "3. 询问用户：你主要在哪些平台发内容？（小红书/抖音/公众号/视频号）",
          "4. 询问用户：你的目标受众是谁？",
          "5. 通过风格校准确定写作风格（正式vs口语、专业vs大白话等）",
          "6. 生成 STYLE.md 并更新 creator-profile.json",
          "7. 完成后再执行用户的原始请求",
        ],
      };
    }

    const missing = detectMissingInfo(profile);
    if (missing.length > 0) {
      return {
        ok: false,
        error: "profile_incomplete",
        message: `⚠️ 创作者档案不完整，缺少：${missing.join("、")}`,
        action_required: `请通过对话补充以下信息：${missing.join("、")}。更新 creator-profile.json 后再继续。`,
        missing,
      };
    }

    if (!profile.styleCalibrated) {
      return {
        ok: false,
        error: "style_not_calibrated",
        message: "⚠️ 还没有完成风格校准。写出来的内容可能不符合你的品牌调性。",
        action_required: "请先进行风格校准：通过 A/B 选择题确定写作风格偏好，生成 STYLE.md，然后更新 creator-profile.json 的 styleCalibrated 为 true。",
        steps: [
          "1. 询问用户的风格偏好（正式vs口语、专业vs大白话、长文vs短文、情感vs干货）",
          "2. 根据回答生成 ~/.autocrew/STYLE.md",
          "3. 更新 creator-profile.json: styleCalibrated = true",
          "4. 完成后再执行用户的原始请求",
        ],
      };
    }
  } catch {
    // If profile check fails, let the tool proceed (don't block on errors)
  }

  return next();
};

/** Inject _dataDir into every tool call */
const dataDirMiddleware: Middleware = async (ctx, _tool, params, next) => {
  params._dataDir = ctx.dataDir;
  params._gatewayUrl = resolveGatewayUrl(ctx);
  return next();
};

/** Inject Gemini config for tools that need it */
const geminiConfigMiddleware: Middleware = async (ctx, _tool, params, next) => {
  // Only inject if the tool definition says it needs Gemini
  // The runner checks this before adding to the chain
  params._geminiApiKey = resolveGeminiKey(ctx);
  params._geminiModel = resolveGeminiModel(ctx);
  return next();
};

/** Catch errors and return friendly error objects */
const errorBoundaryMiddleware: Middleware = async (_ctx, toolName, _params, next) => {
  try {
    return await next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `[${toolName}] ${message}` };
  }
};

/** Record audit trail */
const auditMiddleware: Middleware = async (ctx, toolName, params, next) => {
  const start = Date.now();
  let result: ToolResult;
  try {
    result = await next();
  } catch (err) {
    const entry: AuditEntry = {
      tool: toolName,
      action: params.action as string | undefined,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    recordAudit(ctx, entry);
    throw err;
  }
  const entry: AuditEntry = {
    tool: toolName,
    action: params.action as string | undefined,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    ok: result.ok !== false,
    error: result.error as string | undefined,
  };
  recordAudit(ctx, entry);
  return result;
};

/** Persist tool IO to disk via SessionLogger */
const persistentLogMiddleware: Middleware = async (ctx, toolName, params, next) => {
  const start = Date.now();
  const { _dataDir, _gatewayUrl, _geminiApiKey, _geminiModel, ...loggedInput } = params;
  let result: ToolResult;
  try {
    result = await next();
  } catch (err) {
    if (ctx.logger) {
      await ctx.logger.toolIO({
        tool: toolName,
        action: loggedInput.action as string | undefined,
        input: loggedInput,
        output: { ok: false, error: err instanceof Error ? err.message : String(err) },
        durationMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    }
    throw err;
  }
  if (ctx.logger) {
    await ctx.logger.toolIO({
      tool: toolName,
      action: loggedInput.action as string | undefined,
      input: loggedInput,
      output: result,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
  }
  return result;
};

/** Update workspace state based on tool results */
const workspaceTrackingMiddleware: Middleware = async (ctx, toolName, params, next) => {
  const result = await next();

  // Track active content/topic IDs
  if (result.ok !== false) {
    if (toolName === "autocrew_content" && result.id) {
      updateWorkspace(ctx, { activeContentId: result.id as string });
    }
    if (toolName === "autocrew_topic" && result.id) {
      updateWorkspace(ctx, { activeTopicId: result.id as string });
    }
    updateWorkspace(ctx, { lastToolResult: result, lastToolName: toolName });
  }

  return result;
};

// --- ToolRunner ---

export class ToolRunner {
  private ctx: ToolContext;
  private eventBus?: EventBus;
  private tools = new Map<string, ToolDefinition>();
  private middleware: Middleware[];

  constructor(options: ToolRunnerOptions) {
    this.ctx = options.ctx;
    this.eventBus = options.eventBus;
    this.middleware = [
      dataDirMiddleware,
      onboardingGateMiddleware,
      errorBoundaryMiddleware,
      auditMiddleware,
      persistentLogMiddleware,
      workspaceTrackingMiddleware,
      ...(options.middleware || []),
    ];
  }

  /** Register a tool definition */
  register(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  /** Get all registered tool definitions (for OpenClaw/MCP registration) */
  getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Get a single tool definition by name */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Execute a tool through the middleware pipeline */
  async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    const def = this.tools.get(toolName);
    if (!def) {
      return { ok: false, error: `Unknown tool: ${toolName}` };
    }

    // Build middleware chain for this specific tool
    const chain = [...this.middleware];

    // Inject Gemini config only for tools that need it
    if (def.needsGemini) {
      chain.splice(1, 0, geminiConfigMiddleware); // After dataDir, before errorBoundary
    }

    // Emit PreToolUse event
    if (this.eventBus) {
      this.eventBus.emit(createEvent("tool:pre_execute", { tool: toolName, action: params.action as string }));
    }

    // Execute through middleware chain
    const result = await this.runChain(chain, toolName, { ...params }, def.execute);

    // Emit PostToolUse event
    if (this.eventBus) {
      const eventType = result.ok !== false ? "tool:post_execute" : "tool:execute_failed";
      this.eventBus.emit(createEvent(eventType, {
        tool: toolName,
        action: params.action as string,
        ok: result.ok !== false,
        contentId: (result.id || result.contentId || params.content_id) as string | undefined,
      }));
    }

    return result;
  }

  private async runChain(
    chain: Middleware[],
    toolName: string,
    params: Record<string, unknown>,
    executeFn: ToolExecuteFn,
  ): Promise<ToolResult> {
    let index = 0;
    const next = async (): Promise<ToolResult> => {
      if (index < chain.length) {
        const mw = chain[index++];
        return mw(this.ctx, toolName, params, next);
      }
      return executeFn(params);
    };
    return next();
  }
}
