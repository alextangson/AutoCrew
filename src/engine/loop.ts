/**
 * 薄 agent loop — OpenAI 兼容协议，工具执行，预算上限，withRetry 重试。
 * fetch 注入可测（fetchImpl），生产默认 globalThis.fetch。
 * 参考：spikes/thin-loop/loop.mts（形状参考，禁止 import）。
 */
import { withRetry, checkFetchResponse } from "../utils/retry.js";
import type { EngineConfig } from "./config.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface LoopTool {
  name: string;
  description: string;
  /** JSON Schema（OpenAI function parameters 格式） */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface LoopEvent {
  type: "tool_start" | "tool_end";
  tool: string;
}

export interface LoopOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools?: LoopTool[];
  /** 多轮对话历史（system 之后、本轮 userMessage 之前注入；调用方负责截断） */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** 默认 6 */
  maxTurns?: number;
  /** 默认 20000 */
  maxTotalTokens?: number;
  /** 测试注入；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 流式空闲超时（ms）;默认 IDLE_TIMEOUT_MS。测试注入小值验证挂起中止 */
  idleTimeoutMs?: number;
  /** 工具执行进度回调（UI 状态流）。回调异常被吞——观测层不得破坏执行层。 */
  onEvent?: (e: LoopEvent) => void;
}

export interface LoopResult {
  finalMessage: string;
  turns: number;
  totalTokens: number;
  toolCallCount: number;
  stopReason: "no_tool_calls" | "max_turns" | "max_tokens";
}

/** 流式空闲超时:IDLE 窗口内无任何字节 = relay 挂起（含首字节等待），中止并重试。
 *  非绝对超时——健康长文可流式数分钟,只要字节持续到达就不误杀（dogfood 教训）。 */
const IDLE_TIMEOUT_MS = 45_000;

// ─── Internal types ──────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface CompletionResponse {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
  usage: { total_tokens: number };
}

// ─── Private helpers ─────────────────────────────────────────────────────────

async function callModel(
  config: EngineConfig,
  model: string,
  messages: Message[],
  tools: LoopTool[],
  fetchImpl: typeof fetch,
  idleMs: number = IDLE_TIMEOUT_MS,
): Promise<CompletionResponse> {
  const anthropic = config.protocol === "anthropic";
  const req = anthropic
    ? buildAnthropicRequest(config, model, messages, tools)
    : buildOpenAiRequest(config, model, messages, tools);

  // fetch + 解析整体进 withRetry:流式中途被 relay 掐断（undici "terminated"）或整轮挂起触发重试。
  // 流不可续,重试 = 重发整个请求（生成幂等,新稿）——curl 实测同一 relay 能完成长流,重试大概率成功。
  // 空闲超时（非绝对）:有字节就算活着,idleMs 内一个字节都没有才判挂起→中止→重试。
  //   这样健康的公众号长文（合法流式 >100s）不被误杀,而真挂起（无首字节/中途断流）在空闲窗口内中止。
  return withRetry(async () => {
    const ctrl = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(new Error("engine loop: idle timeout（relay 无响应）")), idleMs);
    };
    resetIdle(); // 覆盖首字节等待（挂起=无首字节）
    try {
      const res = await fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: ctrl.signal,
      });
      checkFetchResponse(res, "engine loop");
      // 按 content-type 分流:真实 relay 回 SSE（stream:true）走流式解析;测试 mock 的 JSON 响应走原路径（零改动）
      const isSse = (res.headers?.get?.("content-type") ?? "").includes("event-stream");
      if (isSse) {
        return await (anthropic ? parseAnthropicStream(res, resetIdle) : parseOpenAiStream(res, resetIdle));
      }
      return anthropic ? parseAnthropic(res) : parseCompletion(res);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  });
}

/** SSE 逐事件读取:按空行分隔的 event/data 块,line-buffered 处理跨 chunk 边界。onChunk 每次读到字节回调（喂空闲看门狗）。 */
async function* readSse(res: Response, onChunk?: () => void): AsyncGenerator<{ event: string; data: string }> {
  const body = res.body;
  if (!body) throw new Error("engine loop: streaming response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk?.(); // 收到字节 → 重置空闲看门狗
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) yield { event, data: dataLines.join("\n") };
    }
  }
}

/** Anthropic 流式 → CompletionResponse（与 parseAnthropic 同形）。thinking 块忽略,tool_use 累积 partial_json。 */
async function parseAnthropicStream(res: Response, onChunk?: () => void): Promise<CompletionResponse> {
  const blocks = new Map<number, { type: string; text: string; id: string; name: string; json: string }>();
  let stopReason = "end_turn";
  let inTok = 0, outTok = 0;
  for await (const { event, data } of readSse(res, onChunk)) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(data); } catch { continue; }
    const type = (e.type as string) || event; // Anthropic data 内含 type;缺失时回退 SSE event 行
    if (type === "message_start") {
      inTok = ((e.message as { usage?: { input_tokens?: number } })?.usage?.input_tokens) ?? 0;
    } else if (type === "content_block_start") {
      const cb = e.content_block as { type: string; id?: string; name?: string };
      blocks.set(e.index as number, { type: cb.type, text: "", id: cb.id ?? "", name: cb.name ?? "", json: "" });
    } else if (type === "content_block_delta") {
      const b = blocks.get(e.index as number);
      const delta = e.delta as { type: string; text?: string; partial_json?: string };
      if (!b) continue;
      if (delta.type === "text_delta") b.text += delta.text ?? "";
      else if (delta.type === "input_json_delta") b.json += delta.partial_json ?? "";
    } else if (type === "message_delta") {
      const d = e.delta as { stop_reason?: string };
      if (d?.stop_reason) stopReason = d.stop_reason;
      outTok = ((e.usage as { output_tokens?: number })?.output_tokens) ?? outTok;
    } else if (type === "error") {
      throw new Error(`engine loop: anthropic stream error（provider: ${(e.error as { message?: string })?.message ?? "unknown"}）`);
    }
  }
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const text = ordered.filter((b) => b.type === "text").map((b) => b.text).join("");
  const toolCalls: ToolCall[] = ordered
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: b.json || "{}" } }));
  return {
    choices: [{
      message: { role: "assistant", content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: stopReason,
    }],
    usage: { total_tokens: inTok + outTok },
  };
}

/** OpenAI 流式 → CompletionResponse（与 parseCompletion 同形）。tool_calls 按 index 累积 arguments。 */
async function parseOpenAiStream(res: Response, onChunk?: () => void): Promise<CompletionResponse> {
  let content = "";
  let finish = "stop";
  let total = 0;
  const tools = new Map<number, { id: string; name: string; args: string }>();
  for await (const { data } of readSse(res, onChunk)) {
    if (data === "[DONE]") break;
    let e: Record<string, unknown>;
    try { e = JSON.parse(data); } catch { continue; }
    const usage = e.usage as { total_tokens?: number } | undefined;
    if (usage?.total_tokens) total = usage.total_tokens;
    const choice = (e.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason as string;
    const delta = choice.delta as { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
    if (delta?.content) content += delta.content;
    for (const tc of delta?.tool_calls ?? []) {
      const cur = tools.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      tools.set(tc.index, cur);
    }
  }
  const toolCalls: ToolCall[] = [...tools.entries()].sort((a, b) => a[0] - b[0]).map((x) => ({
    id: x[1].id, type: "function" as const, function: { name: x[1].name, arguments: x[1].args || "{}" },
  }));
  return {
    choices: [{
      message: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: finish,
    }],
    usage: { total_tokens: total },
  };
}

interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function buildOpenAiRequest(config: EngineConfig, model: string, messages: Message[], tools: LoopTool[]): WireRequest {
  // stream:true 让字节持续流动,避开 relay（Cloudflare）~100s 边缘超时——长文单轮曾 524（dogfood 实测）
  const body: Record<string, unknown> = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body,
  };
}

/**
 * Anthropic Messages 协议(Claude 系中转,2026-07-08 实测创始人通道)。
 * 内部 Message[] → system 顶字段 + user/assistant 消息;工具结果按协议要求
 * 以 tool_result 块紧跟在 assistant tool_use 之后——连续多条 tool 消息合并进
 * 同一条 user 消息。thinking 块在解析侧忽略。
 */
function buildAnthropicRequest(config: EngineConfig, model: string, messages: Message[], tools: LoopTool[]): WireRequest {
  let system = "";
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = m.content ?? "";
      continue;
    }
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content ?? "" };
      const last = out[out.length - 1];
      const lastBlocks = last && last.role === "user" && Array.isArray(last.content) ? (last.content as Array<{ type?: string }>) : null;
      if (lastBlocks && lastBlocks[0]?.type === "tool_result") {
        lastBlocks.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* 模型产出的坏 JSON:保底空对象,让下一轮自纠 */
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role as "user" | "assistant", content: m.content ?? "" });
  }

  // stream:true — 见 buildOpenAiRequest 说明（Cloudflare 边缘超时根治）。
  // max_tokens 16000:公众号包要 5000-6000 字,包进 submit_script 工具 JSON 后需 ~12000 token
  // （dogfood 教训:砍到 8000 会截断触发质量门修复循环）。
  // 注:不设 thinking:disabled——实测该 relay 上「thinking 禁用 + 自由工具选择」会挂死无首字节;
  //    thinking 默认反而能正常流式生成（只是长,靠流式+空闲超时+重试兜住）。
  const body: Record<string, unknown> = { model, max_tokens: 16000, system, messages: out, stream: true };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return {
    url: `${config.baseUrl}/v1/messages`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body,
  };
}

/** Anthropic 响应 → 内部 CompletionResponse 形状(runLoop 零改动)。 */
async function parseAnthropic(res: Response): Promise<CompletionResponse> {
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("engine loop: invalid JSON response");
  }
  const d = data as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!Array.isArray(d.content)) {
    throw new Error(
      `engine loop: malformed anthropic response${d.error?.message ? `（provider: ${d.error.message}）` : ""}`,
    );
  }
  const text = d.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const toolCalls: ToolCall[] = d.content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id ?? "",
      type: "function" as const,
      function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
    }));
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: d.stop_reason ?? "end_turn",
      },
    ],
    usage: { total_tokens: (d.usage?.input_tokens ?? 0) + (d.usage?.output_tokens ?? 0) },
  };
}

/** 200 ≠ 可信：中转/网关可能回 HTML、空 choices 或 error-shaped body（薄云中转路线下是"何时"不是"是否"）。 */
async function parseCompletion(res: Response): Promise<CompletionResponse> {
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("engine loop: invalid JSON response");
  }
  const completion = data as CompletionResponse;
  if (!completion.choices?.[0]?.message) {
    const providerErr = (data as { error?: { message?: string } }).error?.message;
    throw new Error(
      `engine loop: malformed completion response${providerErr ? `（provider: ${providerErr}）` : ""}`,
    );
  }
  return completion;
}

async function executeToolCalls(
  toolCalls: ToolCall[],
  toolMap: Map<string, LoopTool>,
  messages: Message[],
  onEvent?: (e: LoopEvent) => void,
): Promise<number> {
  let count = 0;
  for (const tc of toolCalls) {
    count++;
    const emit = (type: LoopEvent["type"]) => {
      if (!onEvent) return;
      try {
        onEvent({ type, tool: tc.function.name });
      } catch {
        /* 观测层异常不破坏执行层 */
      }
    };
    emit("tool_start");
    let result: string;
    try {
      const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      const tool = toolMap.get(tc.function.name);
      result = tool ? await tool.execute(args) : `Error: Unknown tool: ${tc.function.name}`;
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
    }
    emit("tool_end");
    messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result });
  }
  return count;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runLoop(config: EngineConfig, opts: LoopOptions): Promise<LoopResult> {
  const maxTurns = opts.maxTurns ?? 6;
  const maxTotalTokens = opts.maxTotalTokens ?? 20000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const tools = opts.tools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const messages: Message[] = [
    { role: "system", content: opts.systemPrompt },
    ...(opts.history ?? []).map((m): Message => ({ role: m.role, content: m.content })),
    { role: "user", content: opts.userMessage },
  ];

  let turns = 0;
  let totalTokens = 0;
  let toolCallCount = 0;
  let stopReason: LoopResult["stopReason"] = "no_tool_calls";

  while (turns < maxTurns) {
    if (totalTokens >= maxTotalTokens) {
      stopReason = "max_tokens";
      break;
    }

    const data = await callModel(config, opts.model, messages, tools, fetchImpl, opts.idleTimeoutMs);
    turns++;
    totalTokens += Number(data.usage?.total_tokens) || 0;

    const assistantMsg = data.choices[0].message;
    messages.push({ role: "assistant", content: assistantMsg.content, tool_calls: assistantMsg.tool_calls });

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      stopReason = "no_tool_calls";
      break;
    }

    toolCallCount += await executeToolCalls(toolCalls, toolMap, messages, opts.onEvent);

    if (turns >= maxTurns) {
      stopReason = "max_turns";
    }
  }

  const finalMessage =
    [...messages].reverse().find((m) => m.role === "assistant" && m.content != null)?.content ?? "(no content)";

  return { finalMessage, turns, totalTokens, toolCallCount, stopReason };
}
