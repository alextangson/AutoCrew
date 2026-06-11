// src/engine/loop.test.ts
import { describe, it, expect } from "vitest";
import { runLoop, type LoopTool } from "./loop.js";
import type { EngineConfig } from "./config.js";

const CFG: EngineConfig = { apiKey: "sk-test", baseUrl: "https://fake.local", strongModel: "m", fastModel: "f" };

/** 按顺序回放的 mock fetch；记录每次请求体 */
function mockFetch(responses: Array<Record<string, unknown>>, captured: Array<Record<string, unknown>> = []) {
  let i = 0;
  const impl = (async (_url: unknown, init?: { body?: string }) => {
    captured.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(body), { status: 200 });
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

  it("malformed tool arguments become an Error message", async () => {
    const tool: LoopTool = { name: "x", description: "x", parameters: { type: "object", properties: {} }, execute: () => "ok" };
    const { impl, captured } = mockFetch([
      completion(null, [{ id: "t1", name: "x", args: "{broken" }]),
      completion("done"),
    ]);
    await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], fetchImpl: impl });
    const secondMsgs = captured[1].messages as Array<{ role: string; content?: string }>;
    expect(secondMsgs.some((m) => m.role === "tool" && m.content?.startsWith("Error:"))).toBe(true);
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
      return new Response(JSON.stringify(completion("ok")), { status: 200 });
    }) as typeof fetch;
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
    expect(r.finalMessage).toBe("ok");
    expect(n).toBe(2);
  });

  it("malformed completion (empty choices) throws with context", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ choices: [], usage: { total_tokens: 10 } }), { status: 200 })) as typeof fetch;
    await expect(
      runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl }),
    ).rejects.toThrow(/malformed/);
  });

  it("error-shaped 200 surfaces the provider error message", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 200 })) as typeof fetch;
    await expect(
      runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl }),
    ).rejects.toThrow(/quota exceeded/);
  });

  it("non-JSON 200 body throws invalid JSON error", async () => {
    const impl = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    await expect(
      runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("non-numeric usage cannot poison totalTokens", async () => {
    const body = {
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { total_tokens: "abc" },
    };
    const impl = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
    expect(Number.isFinite(r.totalTokens)).toBe(true);
    expect(r.totalTokens).toBe(0);
  });
});

describe("runLoop history", () => {
  it("injects history messages between system and current user message", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await runLoop(
      CFG,
      {
        model: "f",
        systemPrompt: "sys",
        userMessage: "现在这条",
        history: [
          { role: "user", content: "上一条用户" },
          { role: "assistant", content: "上一条回复" },
        ],
        fetchImpl,
      },
    );

    const messages = capturedBody.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1].content).toBe("上一条用户");
    expect(messages[3].content).toBe("现在这条");
  });
});
