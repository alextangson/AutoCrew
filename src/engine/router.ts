/**
 * 端点路由（P2 spec §4.3 兜底 + P6 spec §3.9 熔断）——「这次模型调用由哪条线来接」。
 *
 * 从 loop.ts 拆出来的只有这一件事：主端点 → 备用端点的切换、调用前的熔断、切换留痕
 * （fallback 事件 / run-log / 健康计数）。编排（工具执行、预算、run-log 的 llm 记录）仍在 loop.ts。
 */
import { withRetry, isRetryable } from "../utils/retry.js";
import type { RunRecorder } from "../runtime/run-log.js";
import { resolveFallbackModel, type EngineConfig } from "./config.js";
import { recordEngineFallback, recordEngineLive } from "./health-sink.js";
import { breakerOpenError, isLineFault, trippedProviders } from "./breaker.js";
import { registerExchange } from "./observer.js";
import { makePiModel, toPiContext, startPiStream, consumePiStream, fromAssistant } from "./pi-wire.js";
import type { LoopEvent, LoopFallbackInfo, LoopStreamEvent, LoopTool } from "./loop.js";

// ─── Internal types ──────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface CompletionResponse {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
  usage: { total_tokens: number };
}

// ─── Routing ─────────────────────────────────────────────────────────────────

export interface ModelCallParams {
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
  /** 健康记录上的任务归属（= logMeta.runId） */
  jobId?: string;
  /** 回退/熔断留痕进同一个 run（P6 §3.9） */
  recorder?: RunRecorder;
}

export interface ModelCallOutcome {
  data: CompletionResponse;
  /** 实际产出本次回复的模型（切了备用就是备用模型名）——run-log 记这个 */
  model: string;
  /** 主端点的失败详情（仅发生切换时非空）：被救回来的那次失败同样要留痕 */
  primaryFailure?: { model: string; error: string; durationMs: number };
  /** 兜底归因（仅发生切换时非空）：LoopResult.usedFallback 与稿卡徽章的数据来源 */
  fallback?: LoopFallbackInfo;
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

/** 本次调用落在哪条线上（config.activeProvider 由 resolveEngineRoute/loadEngineConfig 盖章） */
function attribution(config: EngineConfig): { providerId: string; role: string } {
  return { providerId: config.activeProvider?.id ?? "main", role: config.activeProvider?.role ?? "main" };
}

/** 备用端点在端点表里的 id：v2 起备用也是表里的一条，按 (baseUrl, apiKey) 认回去 */
function fallbackProviderId(config: EngineConfig): string {
  const fb = config.fallback;
  if (!fb) return "fallback";
  return (config.providers ?? []).find((x) => x.baseUrl === fb.baseUrl && x.apiKey === fb.apiKey)?.id ?? "fallback";
}

/** 健康回执（观测层，自吞错）：jobId 取 run-log 的 runId,足够从横幅点回那条任务 */
function live(p: ModelCallParams, providerId: string, role: string, ok: boolean, err?: unknown): void {
  recordEngineLive({
    providerId,
    ok,
    role,
    ...(p.jobId ? { jobId: p.jobId } : {}),
    ...(ok ? {} : { error: errText(err), lineFault: isLineFault(err) }),
  });
}

/** 回退留痕（P6 §3.9）：run-log 一条 kind:"fallback" + 健康文件的当日计数（经 sink，装配方落盘） */
function noteFallback(p: ModelCallParams, e: { from: string; to: string; reason: string; skipped: boolean; ok: boolean }): void {
  p.recorder?.fallback(e);
  recordEngineFallback({ from: e.from, to: e.to, reason: e.reason, skipped: e.skipped });
}

/** 一次调用的传输件：流回调（吞观测层异常）与重试选项，主端点与备用腿共用 */
function transport(p: ModelCallParams) {
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
  return { emitStream, retryOpts };
}

interface FallbackLeg {
  id: string;
  model: string;
  config: EngineConfig;
}

/** 备用腿：备用端点有自己的 key/协议,所以也有自己的 registerExchange（观察器按 upstreamBase 分路由） */
function fallbackLeg(p: ModelCallParams): FallbackLeg | undefined {
  const fb = p.config.fallback;
  const model = resolveFallbackModel(p.config, p.model);
  if (!fb || !model) return undefined;
  return { id: fallbackProviderId(p.config), model, config: { ...p.config, baseUrl: fb.baseUrl, apiKey: fb.apiKey, protocol: fb.protocol } };
}

interface FallbackCause {
  /** 为什么换：主端点的失败原文，或熔断时健康记录里那句 */
  error: string;
  skipped: boolean;
  primaryFailure?: ModelCallOutcome["primaryFailure"];
}

/** 切到备用顶本次调用。切换绝不静默：fallback 事件 + run-log + 健康计数三处留痕 */
async function useFallback(p: ModelCallParams, who: { providerId: string; role: string }, leg: FallbackLeg, cause: FallbackCause): Promise<ModelCallOutcome> {
  const { emitStream, retryOpts } = transport(p);
  const info: LoopFallbackInfo = { role: who.role, from: p.model, to: leg.model, error: cause.error };
  if (p.onEvent) {
    try {
      p.onEvent({ type: "fallback", fromProvider: who.providerId, toProvider: leg.id, ...info });
    } catch {
      /* 观测层异常不破坏执行层 */
    }
  }
  const note = { from: who.providerId, to: leg.id, reason: cause.error, skipped: cause.skipped };
  try {
    const data = await withRetry(() => streamOnce(p, leg.config, leg.model, emitStream), { maxRetries: 1, ...retryOpts });
    live(p, leg.id, who.role, true);
    noteFallback(p, { ...note, ok: true });
    return { data, model: leg.model, ...(cause.primaryFailure ? { primaryFailure: cause.primaryFailure } : {}), fallback: info };
  } catch (fbErr) {
    live(p, leg.id, who.role, false, fbErr);
    noteFallback(p, { ...note, ok: false });
    // 两端都倒了:两条原因一起端给用户,别用备用的错误盖掉主端点的病根
    throw new Error(`模型调用失败 — 主端点: ${cause.error}；备用端点(deepseek): ${errText(fbErr)}`);
  }
}

/**
 * 熔断跳过了主端点（P6 §3.9）：备用健康就直接交给备用，一个字节都不往死线路上发；
 * 备用也熔断/没配备用 → 每条被跳过的线各记一笔，立即抛 engine_unavailable。
 */
async function skipPrimary(p: ModelCallParams, who: { providerId: string; role: string }, leg: FallbackLeg | undefined, tripped: Map<string, string>): Promise<ModelCallOutcome> {
  const reason = tripped.get(who.providerId) ?? "";
  if (leg && !tripped.has(leg.id)) return useFallback(p, who, leg, { error: `熔断跳过：${reason}`, skipped: true });
  noteFallback(p, { from: who.providerId, to: "none", reason, skipped: true, ok: false });
  if (leg) noteFallback(p, { from: leg.id, to: "none", reason: tripped.get(leg.id) ?? "", skipped: true, ok: false });
  throw breakerOpenError(tripped);
}

/**
 * 主端点 → （失败且值得换端点时）备用端点；调用前先过熔断（P6 §3.9）。
 * 换端点的三个前提缺一不可:配了备用、错误确实是可重试类（400/401/403 换个端点照样错）、
 * 用户没点停止（中止长得像瞬时故障,不特判就等于无视用户按的停）。
 */
export async function callModel(p: ModelCallParams): Promise<ModelCallOutcome> {
  const { emitStream, retryOpts } = transport(p);
  const who = attribution(p.config);
  const leg = fallbackLeg(p);
  const tripped = await trippedProviders(p.config.dataDir, leg ? [who.providerId, leg.id] : [who.providerId]);
  if (tripped.has(who.providerId)) return skipPrimary(p, who, leg, tripped);

  const tPrimary = Date.now();
  try {
    const data = await withRetry(() => streamOnce(p, p.config, p.model, emitStream), retryOpts);
    live(p, who.providerId, who.role, true);
    return { data, model: p.model };
  } catch (err) {
    // 中止不是线路的病:用户按了停,不该把端点标成坏的
    if (!p.signal?.aborted) live(p, who.providerId, who.role, false, err);
    if (!leg || !isRetryable(err) || p.signal?.aborted) throw err;
    const fbTripped = tripped.get(leg.id);
    if (fbTripped !== undefined) {
      // 备用在熔断中：不碰它，原样抛主端点的错（调用方的报病分类不变），跳过这件事记账
      noteFallback(p, { from: leg.id, to: "none", reason: fbTripped, skipped: true, ok: false });
      throw err;
    }
    const primaryFailure = { model: p.model, error: errText(err), durationMs: Date.now() - tPrimary };
    return useFallback(p, who, leg, { error: primaryFailure.error, skipped: false, primaryFailure });
  }
}
