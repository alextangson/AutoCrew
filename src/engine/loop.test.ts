// src/engine/loop.test.ts
// pi-ai 迁移版夹具：断言意图与旧版一一对应；fetchImpl 现在喂观察器的上游腿。
// 标注 `pi-ai wire:` 的断言 = pi-ai 产出的合法 wire 与旧手写 wire 的差异点（spec §4）。
import { describe, it, expect, afterAll } from "vitest";
import { runLoop, type LoopTool } from "./loop.js";
import { shutdownObserver } from "./observer.js";
import type { EngineConfig } from "./config.js";

const CFG: EngineConfig = { apiKey: "sk-test", baseUrl: "https://fake.local", strongModel: "m", fastModel: "f" };

afterAll(() => shutdownObserver());

function bodyText(init?: { body?: unknown }): string {
  const b = init?.body;
  if (typeof b === "string") return b;
  if (b instanceof Uint8Array) return new TextDecoder().decode(b);
  return "{}";
}

/** OpenAI 流式 SSE：从旧 completion() 形状生成（delta 化 + usage 末块 + [DONE]） */
function openaiSse(c: Record<string, unknown>): string {
  const choice = (c.choices as Array<Record<string, unknown>>)[0] ?? {};
  const msg = (choice.message ?? {}) as { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  const usage = (c.usage ?? {}) as Record<string, unknown>;
  const chunks: string[] = [];
  if (msg.content) chunks.push(JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: msg.content } }] }));
  if (msg.tool_calls?.length) {
    chunks.push(JSON.stringify({
      choices: [{ index: 0, delta: { tool_calls: msg.tool_calls.map((t, i) => ({ index: i, id: t.id, type: "function", function: { name: t.function.name, arguments: t.function.arguments } })) } }],
    }));
  }
  chunks.push(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: msg.tool_calls?.length ? "tool_calls" : "stop" }] }));
  chunks.push(JSON.stringify({ choices: [], usage }));
  return chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
}

function sseResponse(sse: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(sse);
  let i = 0;
  const stream = new ReadableStream({
    pull(ctrl) {
      if (i >= bytes.length) { ctrl.close(); return; }
      ctrl.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 按顺序回放的 mock fetch；记录每次请求体（观察器上游腿视角 = 真实出 wire） */
function mockFetch(responses: Array<Record<string, unknown>>, captured: Array<Record<string, unknown>> = []) {
  let i = 0;
  const impl = (async (_url: unknown, init?: { body?: unknown }) => {
    captured.push(JSON.parse(bodyText(init)) as Record<string, unknown>);
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return sseResponse(openaiSse(body));
  }) as typeof fetch;
  return { impl, captured };
}

function completion(content: string | null, toolCalls?: Array<{ id: string; name: string; args: string }>, tokens = 100) {
  return {
    id: "x",
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls?.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: tokens / 2, completion_tokens: tokens / 2, total_tokens: tokens },
  };
}

describe("runLoop", () => {
  it("single turn without tools", async () => {
    const { impl, captured } = mockFetch([completion("你好，这是脚本")]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "sys", userMessage: "写一段", fetchImpl: impl });
    expect(r.finalMessage).toBe("你好，这是脚本");
    expect(r.stopReason).toBe("no_tool_calls");
    expect(r.turns).toBe(1);
    expect((captured[0].messages as unknown[]).length).toBe(2); // system + user
  });

  it("does not expose an empty assistant message as the final reply", async () => {
    const { impl } = mockFetch([completion("   ")]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "sys", userMessage: "写一段", fetchImpl: impl });
    expect(r.finalMessage).toBe("(no content)");
  });

  it("executes tool calls and feeds results back", async () => {
    const calls: unknown[] = [];
    const tool: LoopTool = {
      name: "echo",
      description: "回声",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: (args) => {
        calls.push(args);
        return `echo:${args.text}`;
      },
    };
    const { impl, captured } = mockFetch([
      completion(null, [{ id: "t1", name: "echo", args: '{"text":"hi"}' }]),
      completion("完成"),
    ]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], fetchImpl: impl });
    expect(calls).toEqual([{ text: "hi" }]);
    expect(r.toolCallCount).toBe(1);
    expect(r.finalMessage).toBe("完成");
    const secondMsgs = captured[1].messages as Array<{ role: string; content?: string }>;
    expect(secondMsgs.some((m) => m.role === "tool" && m.content === "echo:hi")).toBe(true);
  });

  it("tool error becomes an Error message, loop continues", async () => {
    const tool: LoopTool = {
      name: "boom",
      description: "炸",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw new Error("内部失败");
      },
    };
    const { impl, captured } = mockFetch([
      completion(null, [{ id: "t1", name: "boom", args: "{}" }]),
      completion("已绕过"),
    ]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], fetchImpl: impl });
    expect(r.finalMessage).toBe("已绕过");
    const secondMsgs = captured[1].messages as Array<{ role: string; content?: string }>;
    expect(secondMsgs.some((m) => m.role === "tool" && m.content?.startsWith("Error:"))).toBe(true);
  });

  it("malformed tool arguments are salvaged upstream, loop continues", async () => {
    // pi-ai wire: 坏 JSON 参数在 pi-ai 层被 partial-json 抢救为尽力对象（旧引擎:进 Error 消息）。
    // 契约升级:模型坏输出不再打断回路,也不再需要 Error 自纠轮。
    const seen: unknown[] = [];
    const tool: LoopTool = { name: "x", description: "x", parameters: { type: "object", properties: {} }, execute: (a) => { seen.push(a); return "ok"; } };
    const { impl, captured } = mockFetch([
      completion(null, [{ id: "t1", name: "x", args: "{broken" }]),
      completion("done"),
    ]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], fetchImpl: impl });
    expect(r.finalMessage).toBe("done");
    expect(seen.length).toBe(1); // 工具照常执行(参数为抢救结果),回路不断
    const secondMsgs = captured[1].messages as Array<{ role: string; content?: string }>;
    expect(secondMsgs.some((m) => m.role === "tool" && m.content === "ok")).toBe(true);
  });

  it("stops at maxTurns", async () => {
    const tool: LoopTool = { name: "again", description: "x", parameters: { type: "object", properties: {} }, execute: () => "go" };
    const { impl } = mockFetch([completion(null, [{ id: "t", name: "again", args: "{}" }])]); // 永远要求工具
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], maxTurns: 3, fetchImpl: impl });
    expect(r.turns).toBe(3);
    expect(r.stopReason).toBe("max_turns");
  });

  it("stops when token budget exhausted", async () => {
    const tool: LoopTool = { name: "again", description: "x", parameters: { type: "object", properties: {} }, execute: () => "go" };
    const { impl } = mockFetch([completion(null, [{ id: "t", name: "again", args: "{}" }], 6000)]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], maxTotalTokens: 10000, fetchImpl: impl });
    expect(r.stopReason).toBe("max_tokens");
    expect(r.totalTokens).toBeLessThanOrEqual(12000); // 第二轮轮首被拦
  });

  it("non-retryable API error throws with status", async () => {
    const impl = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    await expect(
      runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl }),
    ).rejects.toThrow(/401/);
  });

  it("retries 429 then succeeds", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      if (n === 1) return new Response("rate limited", { status: 429 });
      return sseResponse(openaiSse(completion("ok")));
    }) as typeof fetch;
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
    expect(r.finalMessage).toBe("ok");
    expect(n).toBe(2);
  });

  it("malformed completion (empty stream) throws with context", async () => {
    // pi-ai wire: 空 choices 流(无 delta 无 finish)= 流早终止 → SDK/pi-ai 报错(旧:parseCompletion 报 malformed)
    const impl = (async () =>
      new Response("data: " + JSON.stringify({ choices: [], usage: { total_tokens: 10 } }) + "\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    await expect(
      runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl }),
    ).rejects.toThrow(/./); // 必须报错而非静默产出空回复;具体文案属 SDK
  });

  it("error-shaped 200 surfaces the provider error message", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 200 })) as typeof fetch;
    await expect(
      runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl }),
    ).rejects.toThrow(/quota exceeded/);
  });

  it("non-JSON 200 body throws instead of hanging or fabricating a reply", async () => {
    const impl = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    await expect(
      runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl }),
    ).rejects.toThrow(/./); // pi-ai wire: 具体文案属 SDK;契约=垃圾 200 必须成为错误
  });

  it("non-numeric usage cannot poison totalTokens", async () => {
    const sse =
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] }) + "\n\n" +
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n" +
      "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: "abc", completion_tokens: "def" } }) + "\n\n" +
      "data: [DONE]\n\n";
    const impl = (async () => sseResponse(sse)) as typeof fetch;
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
    expect(Number.isFinite(r.totalTokens)).toBe(true);
    expect(r.totalTokens).toBe(0);
  });
});

describe("runLoop onEvent", () => {
  it("emits tool_start and tool_end around tool execution, and survives a throwing callback", async () => {
    const { impl } = mockFetch([
      completion(null, [{ id: "t1", name: "echo", args: "{}" }]),
      completion("done"),
    ]);
    const events: Array<Record<string, unknown>> = [];
    const result = await runLoop(
      { apiKey: "k", baseUrl: "https://fake.local", strongModel: "s", fastModel: "f" },
      {
        model: "f",
        systemPrompt: "sys",
        userMessage: "go",
        tools: [{ name: "echo", description: "", parameters: { type: "object", properties: {} }, execute: () => "ok" }],
        fetchImpl: impl,
        onEvent: (e) => {
          events.push(e as unknown as Record<string, unknown>);
          throw new Error("callback boom"); // 回调异常不得破坏 loop
        },
      },
    );

    expect(result.finalMessage).toBe("done");
    expect(events).toEqual([
      { type: "tool_start", tool: "echo" },
      { type: "tool_end", tool: "echo" },
    ]);
  });
});

describe("runLoop history", () => {
  it("injects history messages between system and current user message", async () => {
    const { impl, captured } = mockFetch([completion("ok")]);
    await runLoop(CFG, {
      model: "f",
      systemPrompt: "sys",
      userMessage: "现在这条",
      history: [
        { role: "user", content: "上一条用户" },
        { role: "assistant", content: "上一条回复" },
      ],
      fetchImpl: impl,
    });

    const messages = captured[0].messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1].content).toBe("上一条用户");
    expect(messages[3].content).toBe("现在这条");
  });
});

// ─── Anthropic 协议适配（Claude 系中转,2026-07-08）────────────────────────────

const aev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Anthropic 流式 SSE：从旧 JSON 响应形状生成 */
function anthropicSse(resp: Record<string, unknown>): string {
  const content = (resp.content ?? []) as Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
  const usage = (resp.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  let sse = aev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "x", usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 } } });
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
  sse += aev("message_delta", { type: "message_delta", delta: { stop_reason: resp.stop_reason ?? "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens ?? 0 } });
  sse += aev("message_stop", { type: "message_stop" });
  return sse;
}

describe("anthropic protocol", () => {
  const ACFG: EngineConfig = {
    apiKey: "sk-ant-test", baseUrl: "https://relay.fake/claude", strongModel: "claude-x", fastModel: "claude-x",
    protocol: "anthropic",
  };

  function mockAnthropicFetch(
    responses: Array<Record<string, unknown>>,
    calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [],
  ) {
    let i = 0;
    const impl = (async (url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(bodyText(init)) as Record<string, unknown>,
      });
      const body = responses[Math.min(i, responses.length - 1)];
      i++;
      if (body.error) {
        // 上游 error 形状:真实 relay 以非 2xx + error body 表达(SDK 从 body 提取 message)
        return new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
      }
      return sseResponse(anthropicSse(body));
    }) as typeof fetch;
    return { impl, calls };
  }

  /** pi-ai wire: system 可为 string 或 [{type:"text",text,cache_control}] 块数组(prompt cache) */
  function systemText(system: unknown): string {
    if (typeof system === "string") return system;
    if (Array.isArray(system)) return system.map((b) => (b as { text?: string }).text ?? "").join("");
    return "";
  }

  it("请求打 /v1/messages,带 x-api-key/anthropic-version,tools 映射为 input_schema,system 提顶", async () => {
    const { impl, calls } = mockAnthropicFetch([
      { content: [{ type: "text", text: "好的" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const tool: LoopTool = { name: "echo", description: "回声", parameters: { type: "object", properties: {} }, execute: () => "ok" };
    const result = await runLoop(ACFG, { model: "claude-x", systemPrompt: "你是编辑部", userMessage: "在吗", tools: [tool], fetchImpl: impl });

    expect(result.finalMessage).toBe("好的");
    expect(result.totalTokens).toBe(15);
    expect(calls[0].url).toBe("https://relay.fake/claude/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(systemText(calls[0].body.system)).toBe("你是编辑部"); // pi-ai wire: 块数组形式
    expect(calls[0].body.max_tokens).toBe(16000); // 公众号包要 5000-6000 字,不能砍太狠
    expect(calls[0].body.stream).toBe(true); // 流式:避 Cloudflare 边缘超时
    expect(calls[0].body.thinking).toBeUndefined(); // 不禁 thinking——禁了会在此 relay 挂死(dogfood 教训)
    const tools = calls[0].body.tools as Array<{ name: string; input_schema: unknown }>;
    expect(tools[0].name).toBe("echo");
    expect(tools[0].input_schema).toMatchObject({ type: "object", properties: {} }); // pi-ai wire: 可能附加流式声明字段
  });

  it("tool_use 往返:thinking 块忽略,工具执行,tool_result 以块紧跟在下一条 user 消息", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tool: LoopTool = {
      name: "lookup", description: "查", parameters: { type: "object", properties: {} },
      execute: (args) => { seen.push(args); return "查到了:42"; },
    };
    const { impl, calls } = mockAnthropicFetch([
      {
        content: [
          { type: "thinking", thinking: "..." },
          { type: "tool_use", id: "tu-1", name: "lookup", input: { q: "answer" } },
        ],
        stop_reason: "tool_use", usage: { input_tokens: 20, output_tokens: 10 },
      },
      { content: [{ type: "text", text: "答案是 42" }], stop_reason: "end_turn", usage: { input_tokens: 30, output_tokens: 8 } },
    ]);
    const result = await runLoop(ACFG, { model: "claude-x", systemPrompt: "s", userMessage: "问", tools: [tool], fetchImpl: impl });

    expect(seen).toEqual([{ q: "answer" }]);
    expect(result.finalMessage).toBe("答案是 42");
    expect(result.toolCallCount).toBe(1);

    const secondMsgs = calls[1].body.messages as Array<{ role: string; content: unknown }>;
    const asst = secondMsgs.find((m) => m.role === "assistant" && Array.isArray(m.content));
    expect(asst).toBeDefined();
    const useBlock = (asst!.content as Array<{ type: string; id?: string; input?: unknown }>).find((b) => b.type === "tool_use");
    expect(useBlock).toMatchObject({ id: "tu-1", input: { q: "answer" } });
    const resultMsg = secondMsgs[secondMsgs.length - 1];
    expect(resultMsg.role).toBe("user");
    // pi-ai wire: tool_result 的 content 为块数组(旧引擎为裸字符串);语义等价
    const rb = (resultMsg.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>)[0];
    expect(rb.type).toBe("tool_result");
    expect(rb.tool_use_id).toBe("tu-1");
    expect(JSON.stringify(rb.content)).toContain("查到了:42");
  });

  it("上游 error 形状 → 报错带 provider 信息", async () => {
    const { impl } = mockAnthropicFetch([{ error: { message: "invalid model" } }]);
    await expect(
      runLoop(ACFG, { model: "claude-x", systemPrompt: "s", userMessage: "u", fetchImpl: impl }),
    ).rejects.toThrow(/invalid model/);
  });
});

// ── SSE 流式解析（Cloudflare 524 根治,dogfood 驱动;解析现归 SDK,契约不变）──────
describe("streaming (SSE)", () => {
  const ev = aev;

  const ACFG: EngineConfig = { apiKey: "sk-ant", baseUrl: "https://relay/claude", strongModel: "c", fastModel: "c", protocol: "anthropic" };
  const OCFG: EngineConfig = { apiKey: "sk", baseUrl: "https://relay", strongModel: "m", fastModel: "m", protocol: "openai" };

  it("anthropic text stream: deltas accumulate, thinking ignored, tokens summed", async () => {
    const sse =
      ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "c", usage: { input_tokens: 20, output_tokens: 0 } } }) +
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一下" } }) +
      ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
      ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "本地部署" } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "AI 的主权" } }) +
      ev("content_block_stop", { type: "content_block_stop", index: 1 }) +
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 80 } }) +
      ev("message_stop", { type: "message_stop" });
    const impl = (async () => sseResponse(sse)) as typeof fetch;
    const r = await runLoop(ACFG, { model: "c", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
    expect(r.finalMessage).toBe("本地部署AI 的主权"); // thinking 不进正文
    expect(r.totalTokens).toBe(100);
  });

  it("anthropic tool_use stream: partial_json split across events reassembles", async () => {
    const calls: unknown[] = [];
    const tool: LoopTool = {
      name: "submit", description: "d",
      parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      execute: (a) => { calls.push(a); return "ok"; },
    };
    const turn1 =
      ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "c", usage: { input_tokens: 5, output_tokens: 0 } } }) +
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "submit", input: {} } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"title":"本地' } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'AI"}' } }) +
      ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } }) +
      ev("message_stop", { type: "message_stop" });
    const turn2 =
      ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "c", usage: { input_tokens: 8, output_tokens: 0 } } }) +
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "完成" } }) +
      ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }) +
      ev("message_stop", { type: "message_stop" });
    let n = 0;
    const impl = (async () => sseResponse([turn1, turn2][n++])) as typeof fetch;
    const r = await runLoop(ACFG, { model: "c", systemPrompt: "s", userMessage: "u", tools: [tool], fetchImpl: impl });
    expect(calls).toEqual([{ title: "本地AI" }]); // 跨 event 的 partial_json 正确拼回
    expect(r.finalMessage).toBe("完成");
  });

  it("mid-stream termination retries the whole call and succeeds (dogfood: relay 掐断长流)", async () => {
    const good =
      ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "c", usage: { input_tokens: 5, output_tokens: 0 } } }) +
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "重试成功" } }) +
      ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }) +
      ev("message_stop", { type: "message_stop" });
    let n = 0;
    const impl = (async () => {
      n++;
      if (n === 1) throw new TypeError("terminated"); // 第一次:relay 中途掐断
      return sseResponse(good);
    }) as typeof fetch;
    const r = await runLoop(ACFG, { model: "c", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
    expect(n).toBe(2); // 重发整轮
    expect(r.finalMessage).toBe("重试成功");
  });

  it("idle timeout aborts a hung stream and retries (relay 无响应/中途卡死)", async () => {
    const good =
      ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "c", usage: { input_tokens: 5, output_tokens: 0 } } }) +
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "空闲后重试成功" } }) +
      ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }) +
      ev("message_stop", { type: "message_stop" });
    let n = 0;
    const impl = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      n++;
      if (n === 1) {
        // 第一次:发一点字节后挂起（pull 永不 resolve,直到 abort 时 reject）——观察器看门狗应中止
        const signal = init?.signal;
        const stream = new ReadableStream({
          start(ctrl) { ctrl.enqueue(new TextEncoder().encode("event: ping\ndata: {\"type\":\"ping\"}\n\n")); },
          pull() {
            return new Promise((_, reject) => {
              if (!signal) return; // 无信号则永挂（测试保底靠 vitest 超时,不该走到）
              signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
            });
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return sseResponse(good);
    }) as typeof fetch;
    const r = await runLoop(ACFG, { model: "c", systemPrompt: "s", userMessage: "u", fetchImpl: impl, idleTimeoutMs: 60 });
    expect(n).toBe(2); // 挂起被中止 → 重发整轮
    expect(r.finalMessage).toBe("空闲后重试成功");
  });

  it("openai text stream: delta.content accumulates, usage from final chunk", async () => {
    const sse =
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "你好" } }] }) + "\n\n" +
      "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "世界" }, finish_reason: "stop" }] }) + "\n\n" +
      "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 21, total_tokens: 42 } }) + "\n\n" +
      "data: [DONE]\n\n";
    const impl = (async () => sseResponse(sse)) as typeof fetch;
    const r = await runLoop(OCFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
    expect(r.finalMessage).toBe("你好世界");
    expect(r.totalTokens).toBe(42);
  });
});
