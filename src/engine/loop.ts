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
): Promise<CompletionResponse> {
  const anthropic = config.protocol === "anthropic";
  const req = anthropic
    ? buildAnthropicRequest(config, model, messages, tools)
    : buildOpenAiRequest(config, model, messages, tools);

  let captured: Response | null = null;
  await withRetry(async () => {
    const res = await fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
    });
    checkFetchResponse(res, "engine loop");
    captured = res;
  });

  return anthropic
    ? parseAnthropic(captured as unknown as Response)
    : parseCompletion(captured as unknown as Response);
}

interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function buildOpenAiRequest(config: EngineConfig, model: string, messages: Message[], tools: LoopTool[]): WireRequest {
  const body: Record<string, unknown> = { model, messages };
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

  const body: Record<string, unknown> = { model, max_tokens: 16000, system, messages: out };
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

    const data = await callModel(config, opts.model, messages, tools, fetchImpl);
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
