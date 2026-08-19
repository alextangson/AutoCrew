/**
 * pi-ai wire 适配层（spec §2/§3）：EngineConfig/内部消息 ↔ pi-ai Model/Context/事件流。
 *
 * 边界职责：协议选择、Model 构造（compat 显式钉死，不依赖 URL 自动探测）、
 * 消息双向转换（thinking 忽略）、错误分类（对齐 utils/retry 的可重试语义）。
 * 预算/工具执行/重试编排都在 loop.ts —— 本层无状态、纯函数 + 一次流消费。
 */
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as openaiStream } from "@earendil-works/pi-ai/api/openai-completions";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  Message as PiMessage,
  Tool as PiTool,
} from "@earendil-works/pi-ai";
import { RetryableError } from "../utils/retry.js";
import type { EngineConfig } from "./config.js";

/** 与旧 loop 内部形状一致：runLoop/executeToolCalls 零改动的关键 */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface WireCompletion {
  content: string | null;
  toolCalls: WireToolCall[];
  totalTokens: number;
}

export interface WireTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);

/** 未知模型保守默认（spec §3）：不引入本地截断行为，仅填 pi-ai 必填元数据 */
const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_MAX_TOKENS = 16_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function makePiModel(config: EngineConfig, modelId: string, baseUrl: string): Model<"anthropic-messages"> | Model<"openai-completions"> {
  const shared = {
    id: modelId,
    name: modelId,
    baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
  if (config.protocol === "anthropic") {
    return { ...shared, api: "anthropic-messages", provider: "anthropic" } as Model<"anthropic-messages">;
  }
  // compat 显式钉死（127.0.0.1 环回地址无从自动探测）：system 角色、max_tokens 字段名、
  // 流式 usage 开启 —— 与旧 buildOpenAiRequest 的 wire 对齐
  return {
    ...shared,
    api: "openai-completions",
    provider: "openai",
    compat: {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      supportsStore: false,
      supportsReasoningEffort: false,
    },
  } as Model<"openai-completions">;
}

/** 内部 Message[] → pi-ai Context。system 提为 systemPrompt；tool 结果转 toolResult 角色。 */
export function toPiContext(messages: WireMessage[], tools: WireTool[]): Context {
  let systemPrompt: string | undefined;
  const out: PiMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemPrompt = m.content ?? "";
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "toolResult",
        toolCallId: m.tool_call_id ?? "",
        toolName: m.name ?? "",
        content: [{ type: "text", text: m.content ?? "" }],
      } as PiMessage);
      continue;
    }
    if (m.role === "assistant") {
      // AssistantMessage.content 必须是块数组（string 只有 user 消息可用）
      const content: Record<string, unknown>[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          /* 模型产出的坏 JSON：保底空对象，让下一轮自纠（与旧 buildAnthropicRequest 同语义） */
        }
        content.push({ type: "toolCall", id: tc.id, name: tc.function.name, arguments: args });
      }
      out.push({
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "history",
        model: "history",
        usage: { ...ZERO_COST, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } },
        stopReason: m.tool_calls?.length ? "toolUse" : "stop",
        timestamp: 0,
      } as unknown as PiMessage);
      continue;
    }
    out.push({ role: "user", content: m.content ?? "", timestamp: 0 } as PiMessage);
  }
  return {
    systemPrompt,
    messages: out,
    ...(tools.length > 0
      ? { tools: tools.map((t): PiTool => ({ name: t.name, description: t.description, parameters: t.parameters as PiTool["parameters"] })) }
      : {}),
  };
}

/** AssistantMessage → 内部完成形状。thinking 块忽略；usage 口径 = input+output（与旧 loop 一致，cache 不计入预算）。 */
export function fromAssistant(msg: AssistantMessage): WireCompletion {
  let text = "";
  const toolCalls: WireToolCall[] = [];
  for (const block of msg.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "toolCall") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
      });
    }
  }
  const usage = msg.usage as { input?: number; output?: number } | undefined;
  const totalTokens = (Number(usage?.input) || 0) + (Number(usage?.output) || 0);
  return { content: text || null, toolCalls, totalTokens };
}

/** 发起一次流式调用（协议分派）。maxRetries:0 —— 重试全权归 withRetry，杜绝双重重试。 */
export function startPiStream(
  config: EngineConfig,
  model: Model<"anthropic-messages"> | Model<"openai-completions">,
  context: Context,
): AssistantMessageEventStream {
  if (model.api === "anthropic-messages") {
    return anthropicStream(model as Model<"anthropic-messages">, context, {
      apiKey: config.apiKey,
      maxRetries: 0,
      maxTokens: DEFAULT_MAX_TOKENS, // 旧 wire：anthropic 恒发 max_tokens 16000
      interleavedThinking: false, // 旧 wire 无 interleaved-thinking beta 头
    });
  }
  // 旧 wire：openai 不发 max_tokens —— options.maxTokens 不设即不出现
  return openaiStream(model as Model<"openai-completions">, context, {
    apiKey: config.apiKey,
    maxRetries: 0,
  });
}

/**
 * 消费事件流到终态（重试事务边界 = 这里的完整消费，spec §2）。
 * done → AssistantMessage；error 事件/异常 → 分类后抛出（不产出半成品）。
 *
 * onTextDelta（对话控制面设计 §Phase 3「流式 delta 协议」）：assistant 正文增量逐段透出，
 * 只透 text_delta——thinking 不是给用户看的，toolcall 参数更不是。additive:不传 = 今天的行为。
 * 回调异常吞掉：观测层不得破坏这次流消费（否则一个 UI 推送失败会把整轮打成重试）。
 */
export async function consumePiStream(
  s: AssistantMessageEventStream,
  onTextDelta?: (text: string) => void,
): Promise<AssistantMessage> {
  let final: AssistantMessage | undefined;
  let failure: { message: string } | undefined;
  try {
    for await (const ev of s as AsyncIterable<
      | { type: "done"; message: AssistantMessage }
      | { type: "error"; error: AssistantMessage }
      | { type: "text_delta"; delta: string }
      | { type: string }
    >) {
      if (ev.type === "text_delta") {
        const delta = (ev as { type: "text_delta"; delta: string }).delta;
        if (onTextDelta && delta) {
          try {
            onTextDelta(delta);
          } catch {
            /* 观测层异常不破坏执行层 */
          }
        }
      } else if (ev.type === "done") final = (ev as { type: "done"; message: AssistantMessage }).message;
      else if (ev.type === "error") {
        const e = (ev as { type: "error"; error: AssistantMessage }).error;
        failure = { message: e.errorMessage || "engine loop: provider stream error" };
      }
    }
  } catch (err) {
    throw classifyPiError(err);
  }
  if (failure) throw classifyPiError(new Error(failure.message));
  if (!final) throw classifyPiError(new Error("engine loop: stream ended without done event"));
  return final;
}

/** SDK 连接层错误的消息指纹（观察器掐断/网络中断在 SDK 侧的各种化身）。
 *  注意不含"流干净结束但缺 finish"——那是 malformed 输出,按旧契约 fail-fast。 */
const CONNECTION_ERROR_RE = /premature close|connection error|fetch failed|socket hang up|network error/i;

/** SDK/pi-ai 错误 → utils/retry 可识别的分类（401 不重试、429/5xx/连接类重试）。 */
export function classifyPiError(err: unknown): Error {
  if (err instanceof RetryableError) return err;
  const e = err instanceof Error ? err : new Error(String(err));
  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? ((err as { status: number }).status)
      : Number(/\b(\d{3})\b/.exec(e.message)?.[1] ?? Number.NaN);
  if (Number.isFinite(status)) {
    if (RETRYABLE_STATUS.has(status)) return new RetryableError(e.message, status);
    return e; // 明确的客户端错误（400/401/403/404）：原样抛，不重试
  }
  // SDK 把连接失败包成自己的错误类型/文案（Premature close / Connection error. 等），
  // 旧 isRetryable 的消息模式认不出 —— 在此显式归入可重试
  if (e.name === "APIConnectionError" || CONNECTION_ERROR_RE.test(e.message)) {
    return new RetryableError(e.message);
  }
  // 其余无状态码错误：terminated/aborted/ECONNRESET… 已被 isRetryable 消息模式覆盖，原样抛
  return e;
}
