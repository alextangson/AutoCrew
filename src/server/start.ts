/**
 * AutoCrew Dashboard — standalone entry point.
 *
 * Usage: node --loader ts-node/esm src/server/start.ts [--port 3000]
 */
import { serve } from "@hono/node-server";
import { createContext } from "../runtime/context.js";
import { EventBus } from "../runtime/events.js";
import { ToolRunner } from "../runtime/tool-runner.js";
import { HookManager } from "../runtime/hooks.js";
import { WorkflowEngine } from "../runtime/workflow-engine.js";
import { registerAllTools } from "../tools/registry.js";
import { createApp } from "./index.js";

// --- Parse CLI args ---

function parsePort(args: string[]): number {
  const idx = args.indexOf("--port");
  if (idx !== -1 && args[idx + 1]) {
    const port = Number(args[idx + 1]);
    if (!Number.isNaN(port) && port > 0 && port < 65536) return port;
  }
  return 3000;
}

// --- Main ---

async function main(): Promise<void> {
  const port = parsePort(process.argv);

  // Create runtime
  const ctx = createContext();
  const eventBus = new EventBus();
  const runner = new ToolRunner({ ctx, eventBus });

  // Register tools (single source of truth: src/tools/registry.ts)
  registerAllTools(runner);

  // Initialize hooks
  const hookManager = new HookManager();
  await hookManager.init(eventBus, runner, ctx.dataDir).catch(() => {});

  // Initialize workflow engine
  const workflowEngine = new WorkflowEngine(runner, ctx.dataDir);

  // Create and start server
  const app = createApp({ runner, eventBus, workflowEngine });

  console.log(`AutoCrew Dashboard: http://localhost:${port}`);

  serve({
    fetch: app.fetch,
    port,
  });
}

main().catch((err) => {
  console.error("Failed to start AutoCrew server:", err);
  process.exit(1);
});
