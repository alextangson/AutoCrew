/**
 * 测试夹具（仅测试导入）：pi-ai 迁移后 fetchImpl 喂观察器上游腿，
 * 上游必须说真实 wire 方言（SSE）——本模块把旧 JSON completion 形状转成
 * OpenAI/Anthropic 流式 SSE，让各测试文件的夹具数据零改动存活。
 */

/** 观察器上游腿的请求体是 Uint8Array；旧夹具的 String(init.body) 会拿到乱码 */
export function bodyText(init?: { body?: unknown }): string {
  const b = init?.body;
  if (typeof b === "string") return b;
  if (b instanceof Uint8Array) return new TextDecoder().decode(b);
  return "{}";
}

export function sseResponse(sse: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(sse);
  let i = 0;
  const stream = new ReadableStream({
    pull(ctrl) {
      if (i >= bytes.length) {
        ctrl.close();
        return;
      }
      ctrl.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface CompletionShape {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: Record<string, unknown>;
}

/** OpenAI 流式 SSE：从旧 completion() JSON 形状生成（delta 化 + usage 末块 + [DONE]） */
export function openaiSse(c: CompletionShape): string {
  const msg = c.choices?.[0]?.message ?? {};
  const usage = normalizeUsage(c.usage ?? {});
  const chunks: string[] = [];
  if (msg.content) chunks.push(JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: msg.content } }] }));
  if (msg.tool_calls?.length) {
    chunks.push(
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: msg.tool_calls.map((t, i) => ({
                index: i,
                id: t.id,
                type: "function",
                function: { name: t.function.name, arguments: t.function.arguments },
              })),
            },
          },
        ],
      }),
    );
  }
  chunks.push(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: msg.tool_calls?.length ? "tool_calls" : "stop" }] }));
  chunks.push(JSON.stringify({ choices: [], usage }));
  return chunks.map((x) => `data: ${x}\n\n`).join("") + "data: [DONE]\n\n";
}

/** 旧夹具只给 total_tokens：拆成 prompt/completion（pi-ai 只读拆分字段） */
function normalizeUsage(u: Record<string, unknown>): Record<string, unknown> {
  const total = Number(u.total_tokens);
  const hasSplit = u.prompt_tokens !== undefined || u.completion_tokens !== undefined;
  if (hasSplit || !Number.isFinite(total)) return u;
  const prompt = Math.floor(total / 2);
  return { ...u, prompt_tokens: prompt, completion_tokens: total - prompt };
}

/** jsonResponse(completionShape) 的直接替换 */
export function openaiSseResponse(c: CompletionShape): Response {
  return sseResponse(openaiSse(c));
}

const aev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface AnthropicShape {
  content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anthropic 流式 SSE：从旧 JSON 响应形状生成 */
export function anthropicSse(resp: AnthropicShape): string {
  const content = resp.content ?? [];
  const usage = resp.usage ?? {};
  let sse = aev("message_start", {
    type: "message_start",
    message: { id: "m", type: "message", role: "assistant", content: [], model: "x", usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 } },
  });
  content.forEach((b, i) => {
    if (b.type === "text") {
      sse += aev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      sse += aev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text ?? "" } });
    } else if (b.type === "thinking") {
      sse += aev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } });
      sse += aev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking ?? "" } });
    } else if (b.type === "tool_use") {
      sse += aev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      sse += aev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
    }
    sse += aev("content_block_stop", { type: "content_block_stop", index: i });
  });
  sse += aev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: resp.stop_reason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: usage.output_tokens ?? 0 },
  });
  sse += aev("message_stop", { type: "message_stop" });
  return sse;
}
