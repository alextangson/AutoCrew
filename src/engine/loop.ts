/**
 * 薄 agent loop — 协议层走 pi-ai（spec docs/superpowers/specs/2026-07-17-*.md），
 * 编排（工具执行、预算上限、withRetry 重试、run-log）仍归本层。
 * 传输经环回观察器（observer.ts）：字节级空闲看门狗 + fetchImpl 注入口
 * （测试把 fake 喂到观察器上游腿，生产默认 globalThis.fetch）。
 */
import { withRetry, isRetryable } from "../utils/retry.js";
import { createRunRecorder, type RunRecorder } from "../runtime/run-log.js";
import { resolveFallbackModel, type EngineConfig } from "./config.js";
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

/**
 * 观测事件。fallback = 主端点重试烧完后切到备用模型顶本次调用——
 * 红线：切换绝不静默，聊天进度条与 run-log 都必须看得出这轮是谁在说话。
 */
export type LoopEvent =
  | { type: "tool_start" | "tool_end"; tool: string }
  | { type: "fallback"; from: string; to: string };

/**
 * 流式文本事件（对话控制面设计 §Phase 3「流式 delta 协议」）。
 * reset = 一次新 attempt 开始（withRetry 重试、或工具往返后的新一轮模型调用）——
 * 重试单位是一次完整流消费，失败 attempt 已经吐出去的字必须先作废，
 * 否则 UI 上会出现「同一段话说两遍/改写一半」。reset 之后到达的 delta 属于新 attempt。
 */
export type LoopStreamEvent = { ev: "delta"; text: string } | { ev: "reset" };

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
  /** 重试退避上限（ms）;默认走 withRetry 缺省。测试注入小值,免得为了烧完主端点真睡 7 秒 */
  retryMaxDelayMs?: number;
  /** 工具执行进度回调（UI 状态流）。回调异常被吞——观测层不得破坏执行层。 */
  onEvent?: (e: LoopEvent) => void;
  /**
   * 流式正文回调（设计 §Phase 3）。additive:不传 = 今天的行为(一次都不调)。
   * 每次 attempt 开始先发 reset,再逐段发 delta;多 assistant 轮(工具往返)各轮都走这条。
   * 回调异常同样被吞。
   */
  onTextDelta?: (e: LoopStreamEvent) => void;
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

interface ModelCallParams {
  config: EngineConfig;
  model: string;
  messages: Message[];
  tools: LoopTool[];
  fetchImpl: typeof fetch;
  idleMs: number;
  retryMaxDelayMs?: number;
  signal?: AbortSignal;
  onTextDelta?: (e: LoopStreamEvent) => void;
  onEvent?: (e: LoopEvent) => void;
}

interface ModelCallOutcome {
  data: CompletionResponse;
  /** 实际产出本次回复的模型（切了备用就是备用模型名）——run-log 记这个 */
  model: string;
  /** 主端点的失败详情（仅发生切换时非空）：被救回来的那次失败同样要留痕 */
  primaryFailure?: { model: string; error: string; durationMs: number };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 一次完整流消费 = 重试事务边界（流不可续,重试 = 重发整个请求,生成幂等即新稿）。
 * 中途断流/挂起由观察器字节级看门狗中止（含首字节等待,任何字节续命——健康长文不误杀）,
 * SDK 侧转为连接错误,isRetryable 按消息模式识别。工具提交只发生在流成功收尾之后。
 * 用户中止贯通两处:观察器掐传输,withRetry 不把中止当瞬时故障重放。
 */
async function streamOnce(
  p: ModelCallParams,
  config: EngineConfig,
  model: string,
  emitStream: (e: LoopStreamEvent) => void,
): Promise<CompletionResponse> {
  // 事务边界 = 一次完整流消费,所以 reset 就发在这里:重试、备用 attempt 与新一轮共用
  // 同一条语义,上层不必知道自己收到的是第几次尝试、走的是哪个端点。
  emitStream({ ev: "reset" });
  const exchange = await registerExchange({
    upstreamBase: config.baseUrl,
    fetchImpl: p.fetchImpl,
    idleMs: p.idleMs,
    ...(p.signal ? { signal: p.signal } : {}),
  });
  try {
    const piModel = makePiModel(config, model, exchange.baseUrl);
    const done = await consumePiStream(
      startPiStream(config, piModel, toPiContext(p.messages, p.tools)),
      p.onTextDelta ? (text) => emitStream({ ev: "delta", text }) : undefined,
    );
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
}

/**
 * 主端点 → （失败且值得换端点时）备用端点。
 * 换端点的三个前提缺一不可:配了备用、错误确实是可重试类（400/401/403 换个端点照样错）、
 * 用户没点停止（中止长得像瞬时故障,不特判就等于无视用户按的停）。
 */
async function callModel(p: ModelCallParams): Promise<ModelCallOutcome> {
  const emitStream = (e: LoopStreamEvent) => {
    if (!p.onTextDelta) return;
    try {
      p.onTextDelta(e);
    } catch {
      /* 观测层异常不破坏执行层 */
    }
  };
  const retryOpts = {
    ...(p.signal ? { signal: p.signal } : {}),
    ...(p.retryMaxDelayMs !== undefined ? { maxDelayMs: p.retryMaxDelayMs } : {}),
  };

  const tPrimary = Date.now();
  try {
    const data = await withRetry(() => streamOnce(p, p.config, p.model, emitStream), retryOpts);
    return { data, model: p.model };
  } catch (err) {
    const fb = p.config.fallback;
    const fbModel = resolveFallbackModel(p.config, p.model);
    if (!fb || !fbModel || !isRetryable(err) || p.signal?.aborted) throw err;

    const primaryFailure = { model: p.model, error: errText(err), durationMs: Date.now() - tPrimary };
    if (p.onEvent) {
      try {
        p.onEvent({ type: "fallback", from: p.model, to: fbModel });
      } catch {
        /* 观测层异常不破坏执行层 */
      }
    }
    // 备用端点有自己的 key/协议,所以也有自己的 registerExchange（观察器按 upstreamBase 分路由）
    const fbConfig: EngineConfig = { ...p.config, baseUrl: fb.baseUrl, apiKey: fb.apiKey, protocol: fb.protocol };
    try {
      const data = await withRetry(() => streamOnce(p, fbConfig, fbModel, emitStream), { maxRetries: 1, ...retryOpts });
      return { data, model: fbModel, primaryFailure };
    } catch (fbErr) {
      // 两端都倒了:两条原因一起端给用户,别用备用的错误盖掉主端点的病根
      throw new Error(`模型调用失败 — 主端点: ${primaryFailure.error}；备用端点(deepseek): ${errText(fbErr)}`);
    }
  }
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
    const emit = (type: "tool_start" | "tool_end") => {
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
    let call: ModelCallOutcome;
    try {
      call = await callModel({
        config,
        model: opts.model,
        messages,
        tools,
        fetchImpl,
        idleMs: opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
        ...(opts.retryMaxDelayMs !== undefined ? { retryMaxDelayMs: opts.retryMaxDelayMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onTextDelta ? { onTextDelta: opts.onTextDelta } : {}),
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      });
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
    // 主端点失败但备用救回来了:失败那次照样留痕,否则 run-log 上看不出这轮换过端点
    if (call.primaryFailure) {
      recorder.llm({
        model: call.primaryFailure.model,
        durationMs: call.primaryFailure.durationMs,
        ok: false,
        error: call.primaryFailure.error,
        input: JSON.stringify(messages),
        output: "",
      });
    }
    const data = call.data;
    turns++;
    totalTokens += Number(data.usage?.total_tokens) || 0;

    const assistantMsg = data.choices[0].message;
    recorder.llm({
      model: call.model,
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
