/**
 * AutoCrew Dashboard — standalone entry point.
 *
 * Usage: node --loader ts-node/esm src/server/start.ts [--port 3000]
 */
import { serve } from "@hono/node-server";
import { bootstrap } from "../cli/bootstrap.js";
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
  const { runner, eventBus, workflowEngine } = bootstrap();
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
