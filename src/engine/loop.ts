/**
 * 薄 agent loop — 协议层走 pi-ai（spec docs/superpowers/specs/2026-07-17-*.md），
 * 编排（工具执行、预算上限、run-log）仍归本层；「这次调用由哪条线接」（重试、备用、熔断）在 router.ts。
 * 传输经环回观察器（observer.ts）：字节级空闲看门狗 + fetchImpl 注入口
 * （测试把 fake 喂到观察器上游腿，生产默认 globalThis.fetch）。
 */
import { createRunRecorder, type RunLogAttribution, type RunRecorder } from "../runtime/run-log.js";
import type { EngineConfig } from "./config.js";
import { callModel, type Message, type ModelCallOutcome, type ToolCall } from "./router.js";

// ─── Public types ────────────────────────────────────────────────────────────

export interface LoopTool {
  name: string;
  description: string;
  /** JSON Schema（OpenAI function parameters 格式） */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

/**
 * 兜底留痕（P2 spec §4.3）：主端点失败、备用顶完本次调用。稿卡/任务卡的「备用顶上」
 * 徽章与 hover 全文都从这一份来——`from/to` 是模型名，`fromProvider/toProvider` 是端点 id。
 */
export interface LoopFallbackInfo {
  /** 出事的岗位（config.activeProvider.role；缺省 "main"） */
  role: string;
  from: string;
  to: string;
  /** 主端点这次的失败原文（翻译在消费侧做） */
  error: string;
}

/**
 * 观测事件。fallback = 主端点重试烧完后切到备用模型顶本次调用——
 * 红线：切换绝不静默，聊天进度条与 run-log 都必须看得出这轮是谁在说话。
 * P2 起它带全归因（哪条线、从哪个端点切到哪个端点、主端点当时报了什么）。
 */
export type LoopEvent =
  | { type: "tool_start" | "tool_end"; tool: string }
  | ({ type: "fallback"; fromProvider: string; toProvider: string } & LoopFallbackInfo);

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
  logMeta?: RunLogAttribution & { runId?: string; agent?: string };
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
  /**
   * 本轮用过备用端点（P2 spec §4.3）。调用方把它落进 `Content.usedFallback` /
   * `ResearchJob.usedFallback`——用了备用而稿子上没痕迹，等于兜底从没发生过。
   * 多轮都切过时留最后一次（「这稿最后是谁写的」才是要回答的问题）。
   */
  usedFallback?: LoopFallbackInfo;
}

/** 流式空闲超时:IDLE 窗口内无任何字节 = relay 挂起（含首字节等待），中止并重试。
 *  非绝对超时——健康长文可流式数分钟,只要字节持续到达就不误杀（dogfood 教训）。 */
const IDLE_TIMEOUT_MS = 45_000;

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
  // 多轮都切过就留最后一次:「这稿最后是谁写的」才是稿卡徽章要回答的问题
  let usedFallback: LoopFallbackInfo | undefined;

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
        ...(opts.logMeta?.runId ? { jobId: opts.logMeta.runId } : {}),
        recorder,
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
    if (call.fallback) usedFallback = call.fallback;
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

  return {
    finalMessage,
    turns,
    totalTokens,
    toolCallCount,
    stopReason,
    ...(usedFallback ? { usedFallback } : {}),
  };
}
