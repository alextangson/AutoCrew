/**
 * AutoCrew — Claude Code MCP Server entry point.
 *
 * Exposes the same tools as the OpenClaw plugin via MCP protocol,
 * using the shared ToolRunner for consistent middleware behavior.
 *
 * Usage:
 *   In .claude-plugin/plugin.json, this is referenced as an MCP server.
 *   Or run standalone: node --loader ts-node/esm mcp/server.ts
 */
import { registerAutocrewCapabilities } from "../index.js";
import { loadProfile } from "../src/modules/profile/creator-profile.js";
import { createContext } from "../src/runtime/context.js";
import { ToolRunner } from "../src/runtime/tool-runner.js";
import { EventBus } from "../src/runtime/events.js";
import { HookManager } from "../src/runtime/hooks.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpAccessContext } from "./access.js";

// --- Initialize Runtime ---

const ctx = createContext();
const eventBus = new EventBus();
const runner = new ToolRunner({ ctx, eventBus });
const hookManager = new HookManager();
const workspaceRuntimes = new Map<string, { ctx: typeof ctx; runner: ToolRunner }>();

registerAutocrewCapabilities(runner);

const MCP_PROTOCOL_VERSION = "2025-11-25";
const PROMPTS = [
  { name: "write_wechat", title: "写公众号文章", description: "从明确选题生成公众号原生稿", argument: "topic" },
  { name: "revise_content", title: "按反馈修改稿件", description: "原地修改现有稿件并保存新版本", argument: "feedback" },
  { name: "review_content", title: "审稿", description: "检查敏感词、内容质量与 AI 味", argument: "content_id" },
  { name: "weekly_retro", title: "本周复盘", description: "根据真实发布与回流数据生成周复盘", argument: "focus" },
] as const;

function runtimeFor(dataDir?: string) {
  if (!dataDir || path.resolve(dataDir) === path.resolve(ctx.dataDir)) return { ctx, runner };
  const key = path.resolve(dataDir);
  const cached = workspaceRuntimes.get(key);
  if (cached) return cached;
  const workspaceCtx = createContext({ data_dir: key });
  const workspaceRunner = new ToolRunner({ ctx: workspaceCtx, eventBus: new EventBus() });
  registerAutocrewCapabilities(workspaceRunner);
  const runtime = { ctx: workspaceCtx, runner: workspaceRunner };
  workspaceRuntimes.set(key, runtime);
  return runtime;
}

async function readResource(uri: string, runtime: ReturnType<typeof runtimeFor>): Promise<string | null> {
  if (uri === "autocrew://profile") return JSON.stringify(await loadProfile(runtime.ctx.dataDir), null, 2);
  if (uri === "autocrew://topics") {
    return JSON.stringify(await runtime.runner.execute("autocrew_topic", { action: "list" }), null, 2);
  }
  if (uri === "autocrew://contents") {
    return JSON.stringify(await runtime.runner.execute("autocrew_content", { action: "list" }), null, 2);
  }
  const match = uri.match(/^autocrew:\/\/contents\/(content-\d+-[a-z0-9]+)$/);
  if (match) return JSON.stringify(await runtime.runner.execute("autocrew_content", { action: "get", id: match[1] }), null, 2);
  return null;
}

function promptMessages(name: string, args: Record<string, unknown>) {
  const value = (key: string) => String(args[key] ?? "").trim();
  if (name === "write_wechat") return [{ role: "user", content: { type: "text", text: `用选题《${value("topic")}》写一篇公众号原生文章，并保存到 AutoCrew。` } }];
  if (name === "revise_content") return [{ role: "user", content: { type: "text", text: `读取当前稿件，按以下反馈原地修改并保存新版本：${value("feedback")}` } }];
  if (name === "review_content") return [{ role: "user", content: { type: "text", text: `审查 AutoCrew 稿件 ${value("content_id")}，给出问题并执行可安全自动修复的项目。` } }];
  if (name === "weekly_retro") return [{ role: "user", content: { type: "text", text: `基于 AutoCrew 中的真实数据生成本周复盘。重点：${value("focus") || "选题、内容质量、转化"}。不要编造缺失数据。` } }];
  return null;
}

// Initialize hooks
hookManager.init(eventBus, runner, ctx.dataDir).catch(() => {});

// --- Export for programmatic use ---

export { runner, ctx, eventBus };

interface McpRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function resultResponse(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** 纯 JSON-RPC 处理器：stdio 与 Streamable HTTP 共用，避免协议能力再次漂移。 */
export async function handleMcpRequest(req: McpRequest, access?: McpAccessContext, dataDir?: string): Promise<Record<string, unknown> | null> {
  const { id, method, params } = req;
  const runtime = runtimeFor(dataDir);

  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (method === "initialize") {
    return resultResponse(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
      serverInfo: { name: "autocrew", version: "0.1.0", description: "Local-first AI content operations crew" },
    });
  }
  if (method === "ping") return resultResponse(id, {});
  if (method === "tools/list") {
    return resultResponse(id, {
      tools: runtime.runner.getTools().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
    });
  }
  if (method === "resources/list") {
    return resultResponse(id, {
      resources: [
        { uri: "autocrew://profile", name: "创作者档案", mimeType: "application/json" },
        { uri: "autocrew://topics", name: "选题库", mimeType: "application/json" },
        { uri: "autocrew://contents", name: "内容资产", mimeType: "application/json" },
      ],
    });
  }
  if (method === "resources/read") {
    const uri = String(params?.uri ?? "");
    const text = await readResource(uri, runtime);
    return text === null
      ? errorResponse(id, -32002, `Resource not found: ${uri}`)
      : resultResponse(id, { contents: [{ uri, mimeType: "application/json", text }] });
  }
  if (method === "prompts/list") {
    return resultResponse(id, {
      prompts: PROMPTS.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: [{ name: prompt.argument, required: prompt.name !== "weekly_retro" }],
      })),
    });
  }
  if (method === "prompts/get") {
    const name = String(params?.name ?? "");
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    const messages = promptMessages(name, args);
    return messages
      ? resultResponse(id, { description: PROMPTS.find((prompt) => prompt.name === name)?.description ?? name, messages })
      : errorResponse(id, -32602, `Unknown prompt: ${name}`);
  }
  if (method === "tools/call") {
    const toolName = String(params?.name ?? "");
    const toolArgs = params?.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    if (!runtime.runner.getTool(toolName)) return errorResponse(id, -32601, `Unknown tool: ${toolName}`);
    if (access?.authorize) {
      const permission = await access.authorize(access.principal, toolName, toolArgs);
      if (!permission.ok) return resultResponse(id, {
        content: [{ type: "text", text: permission.error }],
        isError: true,
      });
    }
    const startedAt = Date.now();
    try {
      const result = await runtime.runner.execute(toolName, toolArgs);
      await access?.recordUsage?.({
        subject: access.principal.subject,
        workspaceId: access.principal.workspaceId,
        tool: toolName,
        ok: result.ok !== false,
        durationMs: Date.now() - startedAt,
        occurredAt: new Date().toISOString(),
      });
      return resultResponse(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        ...(result.ok === false ? { isError: true } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await access?.recordUsage?.({
        subject: access.principal.subject,
        workspaceId: access.principal.workspaceId,
        tool: toolName,
        ok: false,
        durationMs: Date.now() - startedAt,
        occurredAt: new Date().toISOString(),
      });
      return resultResponse(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
    }
  }
  return id === undefined ? null : errorResponse(id, -32601, `Method not found: ${method}`);
}

// --- Stdio MCP transport ---

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", async (line: string) => {
    let req: McpRequest;
    try { req = JSON.parse(line); } catch { return; }
    const response = await handleMcpRequest(req);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}
