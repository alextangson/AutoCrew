/**
 * AutoCrew — MCP 协议处理器（纯 JSON-RPC，无传输层）。
 *
 * 工具从唯一注册源（根 `index.ts`）取，与 OpenClaw / CLI / dsh 同一份。
 *
 * 传输只有一条：守护进程的 `POST /mcp`（`desktop/server.ts`）。Claude Code 的 stdio
 * 入口是 `bin/autocrew.mjs mcp`，它把 stdin 上的 JSON-RPC 转发到那个端点——本文件
 * 不再自带 stdio 循环，全部宿主经同一个写进程（P3 §3）。
 */
import { registerAutocrewCapabilities } from "../index.js";
import { loadProfile } from "../src/modules/profile/creator-profile.js";
import { createContext } from "../src/runtime/context.js";
import { ToolRunner } from "../src/runtime/tool-runner.js";
import { EventBus } from "../src/runtime/events.js";
import { HookManager } from "../src/runtime/hooks.js";
import { toLosslessJson } from "../src/utils/lossless-json.js";
import fsp from "node:fs/promises";
import path from "node:path";
import type { McpAccessContext } from "./access.js";

// --- Initialize Runtime ---

const ctx = createContext();
const eventBus = new EventBus();
const runner = new ToolRunner({ ctx, eventBus });
const hookManager = new HookManager();
const workspaceRuntimes = new Map<string, { ctx: typeof ctx; runner: ToolRunner }>();

registerAutocrewCapabilities(runner);

export const MCP_PROTOCOL_VERSION = "2025-11-25";
/**
 * 2026-09-06 实测（日志代理抓包）：Codex CLI 0.145 的远端客户端要 `2025-06-18`，
 * 标准 TS SDK 客户端（Claude Code 用的那个）同样。两家都接受服务端回一个更高的版本，
 * 但按协议该回「客户端要的、我们支持的那个」——回不认识的版本才落到默认值。
 * 两家都没要 `Mcp-Session-Id`、都没坚持 SSE（一次 `GET /mcp` 的 405 被容忍），
 * 所以本片**不**加会话与 SSE。
 */
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-03-26", "2025-06-18", "2025-11-25"]);
/** 宿主归因参数名：服务端注入，客户端传的同名值一律丢弃。 */
export const HOST_PARAM = "_host";
export const DEFAULT_HOST = "local-user";
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

interface ResourcePayload {
  text: string;
  mimeType: string;
}

const CONTENT_ID = "content-\\d+-[a-z0-9]+";

async function readResource(uri: string, runtime: ReturnType<typeof runtimeFor>): Promise<ResourcePayload | null> {
  const json = (value: unknown): ResourcePayload => ({ text: JSON.stringify(value, null, 2), mimeType: "application/json" });
  if (uri === "autocrew://profile") return json(await loadProfile(runtime.ctx.dataDir));
  if (uri === "autocrew://topics") return json(await runtime.runner.execute("autocrew_topic", { action: "list" }));
  if (uri === "autocrew://contents") return json(await runtime.runner.execute("autocrew_content", { action: "list" }));

  // 写作包（P3 §4.2）：宿主模型领包就是读这条资源，正文是 markdown 不是 JSON。
  const pack = uri.match(new RegExp(`^autocrew://contents/(${CONTENT_ID})/writing-pack$`));
  if (pack) {
    const file = path.join(runtime.ctx.dataDir, "contents", pack[1], "writing-pack.md");
    try {
      return { text: await fsp.readFile(file, "utf-8"), mimeType: "text/markdown" };
    } catch {
      return null; // 没领过包 → resources/read 返回 -32002，不给一份空包糊弄过去
    }
  }

  // 待办桌（P3 §6.1）：三张桌子各一条资源，内容与 `autocrew_desk inbox` 逐字段相同——
  // 宿主用资源浏览、用工具认领，两边不许各算一套待办。
  const desk = uri.match(/^autocrew:\/\/desk\/(writer|cover|editor)$/);
  if (desk) return json(await runtime.runner.execute("autocrew_desk", { action: "inbox", employee: desk[1] }));

  const match = uri.match(new RegExp(`^autocrew://contents/(${CONTENT_ID})$`));
  if (match) return json(await runtime.runner.execute("autocrew_content", { action: "get", id: match[1] }));
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
    const requested = String(params?.protocolVersion ?? "");
    const clientInfo = params?.clientInfo as { name?: unknown } | undefined;
    // clientInfo 只作日志：无会话的 HTTP 上它没有稳定落点，归因靠命名 token（§4.1）。
    console.info(`[mcp] initialize client=${String(clientInfo?.name ?? "unknown")} protocol=${requested || "unset"} host=${access?.host ?? DEFAULT_HOST}`);
    return resultResponse(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
      serverInfo: { name: "autocrew", version: "0.1.0", description: "Local-first AI content operations crew" },
    });
  }
  if (method === "ping") return resultResponse(id, {});
  if (method === "tools/list") {
    return resultResponse(id, {
      // TypeBox schema 上挂着 own symbol，直接吐出去在传输里会静默丢字段——先过 lossless。
      tools: toLosslessJson(
        runtime.runner.getTools().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
      ),
    });
  }
  if (method === "resources/list") {
    return resultResponse(id, {
      resources: [
        { uri: "autocrew://profile", name: "创作者档案", mimeType: "application/json" },
        { uri: "autocrew://topics", name: "选题库", mimeType: "application/json" },
        { uri: "autocrew://contents", name: "内容资产", mimeType: "application/json" },
        { uri: "autocrew://desk/writer", name: "写手待办桌", mimeType: "application/json" },
        { uri: "autocrew://desk/cover", name: "封面师待办桌", mimeType: "application/json" },
        { uri: "autocrew://desk/editor", name: "剪辑师待办桌", mimeType: "application/json" },
      ],
    });
  }
  if (method === "resources/read") {
    const uri = String(params?.uri ?? "");
    const payload = await readResource(uri, runtime);
    return payload === null
      ? errorResponse(id, -32002, `Resource not found: ${uri}`)
      : resultResponse(id, { contents: [{ uri, mimeType: payload.mimeType, text: payload.text }] });
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
    const rawArgs = params?.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    // 宿主归因（§4.1）：客户端自报的 `_host` 一律丢弃，只认认证时定下的主体。
    const toolArgs: Record<string, unknown> = { ...rawArgs, [HOST_PARAM]: access?.host ?? DEFAULT_HOST };
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
      const lossless = toLosslessJson(result);
      return resultResponse(id, {
        content: [{ type: "text", text: JSON.stringify(lossless, null, 2) }],
        structuredContent: lossless,
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

// stdio 入口已删（P3 §3）：`bin/autocrew.mjs mcp` 改成把 JSON-RPC 转发到守护进程的
// `POST /mcp`，全部宿主经同一个写进程。留一条能在别处再起一个写进程的路，等于把
// `transitionStatus` 的按 id 串行重新变成 last-writer-wins。
