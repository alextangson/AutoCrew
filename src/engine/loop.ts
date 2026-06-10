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

export interface LoopOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools?: LoopTool[];
  /** 默认 6 */
  maxTurns?: number;
  /** 默认 20000 */
  maxTotalTokens?: number;
  /** 测试注入；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
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
  const body: Record<string, unknown> = {
    model,
    messages,
  };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  let captured: Response | null = null;
  await withRetry(async () => {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
    });
    checkFetchResponse(res, "engine loop");
    captured = res;
  });

  return (await (captured as unknown as Response).json()) as CompletionResponse;
}

async function executeToolCalls(
  toolCalls: ToolCall[],
  toolMap: Map<string, LoopTool>,
  messages: Message[],
): Promise<number> {
  let count = 0;
  for (const tc of toolCalls) {
    count++;
    let result: string;
    try {
      const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      const tool = toolMap.get(tc.function.name);
      result = tool ? await tool.execute(args) : `Error: Unknown tool: ${tc.function.name}`;
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
    }
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
    totalTokens += data.usage?.total_tokens ?? 0;

    const assistantMsg = data.choices[0].message;
    messages.push({ role: "assistant", content: assistantMsg.content, tool_calls: assistantMsg.tool_calls });

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      stopReason = "no_tool_calls";
      break;
    }

    toolCallCount += await executeToolCalls(toolCalls, toolMap, messages);

    if (turns >= maxTurns) {
      stopReason = "max_turns";
    }
  }

  const finalMessage =
    [...messages].reverse().find((m) => m.role === "assistant" && m.content != null)?.content ?? "(no content)";

  return { finalMessage, turns, totalTokens, toolCallCount, stopReason };
}
