/**
 * AutoCrew — Claude Code MCP Server entry point.
 *
 * Exposes the same tools as the OpenClaw plugin via MCP protocol,
 * using the shared ToolRunner for consistent middleware behavior.
 *
 * Usage:
 *   autocrew mcp
 *   Or run standalone: node --loader ts-node/esm mcp/server.ts
 */
import { bootstrap } from "../src/cli/bootstrap.js";

const { runner, ctx, eventBus } = bootstrap();

// --- Export for programmatic use ---

export { runner, ctx, eventBus };

// --- Stdio MCP transport ---

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });

  function respond(id: unknown, result: unknown) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  function respondError(id: unknown, code: number, message: string) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  }

  rl.on("line", async (line: string) => {
    let req: any;
    try { req = JSON.parse(line); } catch { return; }

    const { id, method, params } = req;

    if (method === "initialize") {
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "autocrew", version: "0.1.0" },
      });
      return;
    }

    if (method === "tools/list") {
      respond(id, {
        tools: runner.getTools().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        })),
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      if (!runner.getTool(toolName)) {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }
      try {
        const result = await runner.execute(toolName, toolArgs);
        respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err: any) {
        respond(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
      return;
    }

    if (id !== undefined) {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  });
}
