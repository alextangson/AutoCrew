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
} from "./context.js";
import { type EventBus, createEvent } from "./events.js";

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
}

export interface ToolRunnerOptions {
  ctx: ToolContext;
  eventBus?: EventBus;
  middleware?: Middleware[];
}

// --- Built-in Middleware ---

/** Inject _dataDir into every tool call */
const dataDirMiddleware: Middleware = async (ctx, _tool, params, next) => {
  params._dataDir = ctx.dataDir;
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
      errorBoundaryMiddleware,
      auditMiddleware,
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
