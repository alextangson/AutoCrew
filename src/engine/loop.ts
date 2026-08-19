/**
 * 薄 agent loop — 协议层走 pi-ai（spec docs/superpowers/specs/2026-07-17-*.md），
 * 编排（工具执行、预算上限、withRetry 重试、run-log）仍归本层。
 * 传输经环回观察器（observer.ts）：字节级空闲看门狗 + fetchImpl 注入口
 * （测试把 fake 喂到观察器上游腿，生产默认 globalThis.fetch）。
 */
import { withRetry } from "../utils/retry.js";
import { createRunRecorder, type RunRecorder } from "../runtime/run-log.js";
import type { EngineConfig } from "./config.js";
import { registerExchange } from "./observer.js";
import { makePiModel, toPiContext, startPiStream, consumePiStream, fromAssistant } from "./pi-wire.js";

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
  /** 运行日志归属(V5.6):runId 缺省自动生成 run-eng-…;config.dataDir 缺省不落日志 */
  logMeta?: { runId?: string; agent?: string; usedPatternIds?: string[]; usedBriefRevision?: number };
  /**
   * 用户中止（对话控制面设计 §Phase 3）。additive:不传 = 今天的行为。
   * 检查点 = 每次模型调用前 + 每个工具执行之间；贯通到观察器（掐传输）与 withRetry（不重放）。
   * 中止**不走 throw 出口**——正常返回 stopReason:"aborted"，调用方按正常轮收尾。
   */
  signal?: AbortSignal;
}

export interface LoopResult {
  finalMessage: string;
  turns: number;
  totalTokens: number;
  toolCallCount: number;
  /** aborted = 用户中止（不是失败）：已完成的工具产出保留，剩余工具跳过 */
  stopReason: "no_tool_calls" | "max_turns" | "max_tokens" | "aborted";
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
  signal?: AbortSignal,
): Promise<CompletionResponse> {
  // 完整流消费在 withRetry 事务内:流不可续,重试 = 重发整个请求（生成幂等,新稿）。
  // 中途断流/挂起由观察器字节级看门狗中止（含首字节等待,任何字节续命——健康长文不误杀）,
  // SDK 侧转为连接错误,isRetryable 按消息模式识别。工具提交只发生在流成功收尾之后。
  // 用户中止贯通两处:观察器掐传输,withRetry 不把中止当瞬时故障重放。
  return withRetry(async () => {
    const exchange = await registerExchange({ upstreamBase: config.baseUrl, fetchImpl, idleMs, ...(signal ? { signal } : {}) });
    try {
      const piModel = makePiModel(config, model, exchange.baseUrl);
      const done = await consumePiStream(startPiStream(config, piModel, toPiContext(messages, tools)));
      const wire = fromAssistant(done);
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: wire.content,
              ...(wire.toolCalls.length ? { tool_calls: wire.toolCalls } : {}),
            },
            finish_reason: done.stopReason === "toolUse" ? "tool_calls" : "stop",
          },
        ],
        usage: { total_tokens: wire.totalTokens },
      };
    } finally {
      exchange.release();
    }
  }, signal ? { signal } : undefined);
}

async function executeToolCalls(
  toolCalls: ToolCall[],
  toolMap: Map<string, LoopTool>,
  messages: Message[],
  onEvent?: (e: LoopEvent) => void,
  recorder?: RunRecorder,
  signal?: AbortSignal,
): Promise<number> {
  let count = 0;
  for (const tc of toolCalls) {
    // 工具边界语义（不宣称原子）：已开始的工具跑完，剩余未执行的跳过。
    if (signal?.aborted) break;
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
    const tStart = Date.now();
    let result: string;
    try {
      const args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      const tool = toolMap.get(tc.function.name);
      result = tool ? await tool.execute(args) : `Error: Unknown tool: ${tc.function.name}`;
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
    }
    emit("tool_end");
    recorder?.tool({
      name: tc.function.name,
      durationMs: Date.now() - tStart,
      ok: !result.startsWith("Error"),
      input: tc.function.arguments,
      output: result,
    });
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
  const recorder = createRunRecorder(config.dataDir, opts.logMeta);

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
    // 中止检查点之一：模型调用前（本轮还没开销就停住）
    if (opts.signal?.aborted) {
      stopReason = "aborted";
      break;
    }

    const tCall = Date.now();
    let data: CompletionResponse;
    try {
      data = await callModel(config, opts.model, messages, tools, fetchImpl, opts.idleTimeoutMs, opts.signal);
    } catch (err) {
      recorder.llm({
        model: opts.model,
        durationMs: Date.now() - tCall,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        input: JSON.stringify(messages),
        output: "",
      });
      // 用户中止不是失败轮：调用失败是我们自己掐的,正常返回 aborted（设计 §Phase 3 二审 #8）
      if (opts.signal?.aborted) {
        stopReason = "aborted";
        break;
      }
      throw err;
    }
    turns++;
    totalTokens += Number(data.usage?.total_tokens) || 0;

    const assistantMsg = data.choices[0].message;
    recorder.llm({
      model: opts.model,
      durationMs: Date.now() - tCall,
      ok: true,
      tokens: Number(data.usage?.total_tokens) || 0,
      input: JSON.stringify(messages),
      output: JSON.stringify(assistantMsg),
    });
    messages.push({ role: "assistant", content: assistantMsg.content, tool_calls: assistantMsg.tool_calls });

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      stopReason = "no_tool_calls";
      break;
    }

    toolCallCount += await executeToolCalls(toolCalls, toolMap, messages, opts.onEvent, recorder, opts.signal);

    // 工具间中止：剩余工具已跳过,这里直接收尾（不再回模型要下一轮）
    if (opts.signal?.aborted) {
      stopReason = "aborted";
      break;
    }

    if (turns >= maxTurns) {
      stopReason = "max_turns";
    }
  }

  const lastAssistantText = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim() !== "")?.content;
  // 中止时没有助手文本就是空串——「(no content)」是「模型没吐字」的信号,不是「用户按了停」
  const finalMessage = lastAssistantText ?? (stopReason === "aborted" ? "" : "(no content)");

  return { finalMessage, turns, totalTokens, toolCallCount, stopReason };
}
