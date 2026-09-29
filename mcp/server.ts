import { contentFile } from "../src/storage/content-project.js";
/**
 * AutoCrew — MCP 协议处理器（纯 JSON-RPC，无传输层）。
 *
 * 工具从唯一注册源（根 `index.ts`）取，与 OpenClaw / CLI / dsh 同一份。
 *
 * 传输只有一条：守护进程的 `POST /mcp`（`desktop/server.ts`）。Claude Code 的 stdio
 * 入口是 `bin/autocrew.mjs mcp`，它把 stdin 上的 JSON-RPC 转发到那个端点——本文件
 * 不再自带 stdio 循环，全部宿主经同一个写进程（P3 §3）。
 */
import { WRITING_INSTRUCTIONS, MCP_INSTRUCTIONS } from "./writing-instructions.js";
import { mcpToolView, TOOL_GUIDE_PREFIX, toolGuideText } from "./tool-docs.js";
import { withMisuseGuide } from "./misuse-guide.js";
import { registerAutocrewCapabilities } from "../index.js";
import { loadProfile } from "../src/modules/profile/creator-profile.js";
import { createContext } from "../src/runtime/context.js";
import { ToolRunner } from "../src/runtime/tool-runner.js";
import { EventBus } from "../src/runtime/events.js";
import { HookManager } from "../src/runtime/hooks.js";
import { toLosslessJson } from "../src/utils/lossless-json.js";
import { withCallerSession } from "../src/runtime/run-log.js";
import fsp from "node:fs/promises";
import path from "node:path";
import type { McpAccessContext } from "./access.js";
import { hiddenToolNote, hostListsTool } from "./host-policy.js";

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
/** 会话归因参数名（P6 §3.8）：同 `_host`，服务端注入，客户端传的同名值一律丢弃 */
export const SESSION_PARAM = "_session";
export const UNKNOWN_SESSION = "unknown";
const SESSION_RE = /^[A-Za-z0-9._:-]{1,80}$/;

/**
 * `X-AutoCrew-Session` 头 → 会话 nonce。这是系统边界上的外来值：会落进稿件 JSON 与 run-log，
 * 所以只收短的安全字符；缺失或不像样一律 `unknown`（它只做诊断，认不出不该拦请求）。
 */
export function normalizeSession(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return UNKNOWN_SESSION;
  const trimmed = value.trim();
  return SESSION_RE.test(trimmed) ? trimmed : UNKNOWN_SESSION;
}
const PROMPTS = [
  { name: "insights", title: "账号洞察与团队下一步", description: "分析现有内容和平台数据，输出账号报告及明确团队行动建议", argument: "focus" },
  { name: "write_content", title: "准备一篇内容", description: "从写作需求开始，检查材料、推荐立意，再由当前模型写稿", argument: "requirements" },
  { name: "write_wechat", title: "写公众号文章", description: "从明确选题生成公众号原生稿", argument: "topic" },
  { name: "revise_content", title: "按反馈修改稿件", description: "原地修改现有稿件并保存新版本", argument: "feedback" },
  { name: "review_content", title: "检查稿件", description: "由当前宿主检查规划、事实与表达，并标明审稿来源", argument: "content_id" },
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
  if (uri === "autocrew://writing-guide") return { text: WRITING_INSTRUCTIONS, mimeType: "text/markdown" };
  // 工具的完整用法（瘦身前的长说明原文）按需读取（spec v1.3 §2）
  if (uri.startsWith(TOOL_GUIDE_PREFIX)) {
    const tool = runtime.runner.getTool(uri.slice(TOOL_GUIDE_PREFIX.length));
    // 原长说明 + 原参数结构（含每个参数的原说明、嵌套载荷的字段与单位）：tools/list 里删掉的都在这里（评审 v1.3 P2）
    return tool ? { text: toolGuideText(tool.name, tool.description, toLosslessJson(tool.parameters)), mimeType: "text/markdown" } : null;
  }
  if (uri === "autocrew://profile") return json(await loadProfile(runtime.ctx.dataDir));
  if (uri === "autocrew://topics") return json(await runtime.runner.execute("autocrew_topic", { action: "list" }));
  if (uri === "autocrew://contents") return json(await runtime.runner.execute("autocrew_content", { action: "list" }));

  // 写作包（P3 §4.2）：宿主模型领包就是读这条资源，正文是 markdown 不是 JSON。
  const pack = uri.match(new RegExp(`^autocrew://contents/(${CONTENT_ID})/writing-pack$`));
  if (pack) {
    const file = contentFile(pack[1], runtime.ctx.dataDir, "writing-pack.md");
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
  if (name === "insights") return [{ role: "user", content: { type: "text", text: `请生成AutoCrew账号洞察报告。先调用autocrew_insights prepare（默认近30天，用户另有范围则遵从），读取现有内容、定位、回流数据和生产进度；由当前宿主分析并调用submit保存，不调用后台模型。给出有证据的账号判断，以及新媒体团队各相关岗位的具体动作、交付物、验证指标和优先级。必须完成submit并把报告交给我，不停在备料。保存建议不等于执行建议，不自动改稿或发布。重点：${value("focus") || "账号表现、内容机会与下一批团队行动"}。` } }];
  if (name === "write_content") return [{ role: "user", content: { type: "text", text: `${WRITING_INSTRUCTIONS}\n\n本次需求：${value("requirements")}` } }];
  if (name === "write_wechat") return [{ role: "user", content: { type: "text", text: `${WRITING_INSTRUCTIONS}\n\n本次需求：用选题《${value("topic")}》写一篇公众号原生文章，先用 workflow prepare 准备材料与立意。` } }];
  if (name === "revise_content") return [{ role: "user", content: { type: "text", text: `先用 autocrew_editorial inspect 读取当前稿件与 draft_hash，再用 feedback 保存用户本次已确认的修改要求；按返回的 writer pack 流程原地改稿、submit 和 review_desk 审稿。默认由当前宿主执行，不调用后台改稿模型。反馈：${value("feedback")}` } }];
  if (name === "review_content") return [{ role: "user", content: { type: "text", text: `读取 AutoCrew 稿件 ${value("content_id")}，用 autocrew_review_desk pack 领取审稿任务，由当前宿主核对规划、事实与表达，再用 submit 交回具体问题与受众建议。不调用后台模型；按 review_source 说明审稿来源，host_self_review 是同宿主自审，不能称独立审稿。autocrew_review 仅做词表和阅读格式检查。没有写作包时如实说明需先领取 writer 包。不自动替创作者批准。` } }];
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

/** 记一次用量（商业化计费口）：成败都记，失败不许让计费漏掉 */
async function recordUsage(access: McpAccessContext | undefined, tool: string, ok: boolean, startedAt: number): Promise<void> {
  await access?.recordUsage?.({
    subject: access.principal.subject,
    workspaceId: access.principal.workspaceId,
    tool,
    ok,
    durationMs: Date.now() - startedAt,
    occurredAt: new Date().toISOString(),
  });
}

/** `tools/call`：注入归因参数 → 按宿主限权 → 在会话上下文里执行 */
async function callTool(
  id: unknown,
  params: Record<string, unknown> | undefined,
  access: McpAccessContext | undefined,
  runtime: ReturnType<typeof runtimeFor>,
): Promise<Record<string, unknown>> {
  const toolName = String(params?.name ?? "");
  const rawArgs = params?.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
  // 宿主归因（§4.1）：客户端自报的 `_host` 一律丢弃，只认认证时定下的主体；
  // 会话归因（P6 §3.8）同一条规矩，`_session` 只认传输层带来的那个。
  const host = access?.host ?? DEFAULT_HOST;
  const session = access?.session ?? UNKNOWN_SESSION;
  const toolArgs: Record<string, unknown> = { ...rawArgs, [HOST_PARAM]: host, [SESSION_PARAM]: session };
  if (!runtime.runner.getTool(toolName)) return errorResponse(id, -32601, `Unknown tool: ${toolName}`);
  if (access?.authorize) {
    const permission = await access.authorize(access.principal, toolName, toolArgs);
    if (!permission.ok) {
      const body = permission.result;
      return resultResponse(id, body
        ? { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: true }
        : { content: [{ type: "text", text: permission.error }], isError: true });
    }
  }
  const startedAt = Date.now();
  try {
    // 会话挂在这次调用的异步上下文上：run-log 与认领/交接账顺手记上它，不经参数层层传
    // 被拒又没带 next_action 的，补一个指向正确动作的（v1.3 M2：说明变短后流程靠返回兜住）
    const executed = withMisuseGuide(toolName, rawArgs, await withCallerSession(session, () => runtime.runner.execute(toolName, toolArgs)));
    const note = hiddenToolNote(host, toolName);
    const result = note ? { ...executed, host_note: note } : executed;
    await recordUsage(access, toolName, result.ok !== false, startedAt);
    const lossless = toLosslessJson(result);
    return resultResponse(id, {
      content: [{ type: "text", text: JSON.stringify(lossless, null, 2) }],
      structuredContent: lossless,
      ...(result.ok === false ? { isError: true } : {}),
    });
  } catch (err) {
    await recordUsage(access, toolName, false, startedAt);
    return resultResponse(id, { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
  }
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
      instructions: MCP_INSTRUCTIONS,
      serverInfo: { name: "autocrew", version: "0.1.0", description: "Local-first AI content operations crew" },
    });
  }
  if (method === "ping") return resultResponse(id, {});
  if (method === "tools/list") {
    // 按宿主过滤（P6 §3.7）：只减 Claude/Codex 会话的上下文，注册表与 tools/call 一个不动
    const host = access?.host ?? DEFAULT_HOST;
    const listed = runtime.runner.getTools().filter((tool) => hostListsTool(host, tool.name));
    return resultResponse(id, {
      // TypeBox schema 上挂着 own symbol，直接吐出去在传输里会静默丢字段——先过 lossless。
      // 给宿主的是瘦身版说明（mcp/tool-docs.ts）；参数结构只做等价压缩，契约不变
      tools: toLosslessJson(listed.map((tool) => mcpToolView({ name: tool.name, description: tool.description, parameters: toLosslessJson(tool.parameters) }))),
    });
  }
  if (method === "resources/list") {
    return resultResponse(id, {
      resources: [
        { uri: "autocrew://writing-guide", name: "写作默认流程与交付标准", mimeType: "text/markdown" },
        // 每个本宿主能用的工具一条真实 URI（评审 v1.3 P3：不再挂一个字面的 <工具名> 占位）
        ...runtime.runner.getTools().filter((tool) => hostListsTool(access?.host ?? DEFAULT_HOST, tool.name))
          .map((tool) => ({ uri: `${TOOL_GUIDE_PREFIX}${tool.name}`, name: `${tool.name} 的完整用法`, mimeType: "text/markdown" })),
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
        arguments: [{ name: prompt.argument, required: !["weekly_retro", "insights"].includes(prompt.name) }],
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
  if (method === "tools/call") return callTool(id, params, access, runtime);
  return id === undefined ? null : errorResponse(id, -32601, `Method not found: ${method}`);
}

// stdio 入口已删（P3 §3）：`bin/autocrew.mjs mcp` 改成把 JSON-RPC 转发到守护进程的
// `POST /mcp`，全部宿主经同一个写进程。留一条能在别处再起一个写进程的路，等于把
// `transitionStatus` 的按 id 串行重新变成 last-writer-wins。
