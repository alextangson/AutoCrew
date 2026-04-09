/**
 * Shared runtime initialization for all entry points (CLI, MCP, HTTP server, OpenClaw adapter).
 * Single source of truth — eliminates duplicated bootstrap code.
 */
import { createContext, type PluginConfig } from "../runtime/context.js";
import { SessionLogger } from "../runtime/logger.js";
import { ToolRunner } from "../runtime/tool-runner.js";
import { EventBus } from "../runtime/events.js";
import { HookManager } from "../runtime/hooks.js";
import { WorkflowEngine } from "../runtime/workflow-engine.js";
import { registerAllTools } from "../tools/registry.js";

export interface BootstrapResult {
  ctx: ReturnType<typeof createContext>;
  eventBus: EventBus;
  runner: ToolRunner;
  hookManager: HookManager;
  workflowEngine: WorkflowEngine;
}

export function bootstrap(config?: PluginConfig): BootstrapResult {
  const ctx = createContext(config);
  const logger = new SessionLogger(ctx.dataDir, ctx.sessionId);
  ctx.logger = logger;
  const eventBus = new EventBus();
  const runner = new ToolRunner({ ctx, eventBus });

  registerAllTools(runner);

  const hookManager = new HookManager();
  hookManager.init(eventBus, runner, ctx.dataDir).catch(() => {});

  const workflowEngine = new WorkflowEngine(runner, ctx.dataDir);

  return { ctx, eventBus, runner, hookManager, workflowEngine };
}
