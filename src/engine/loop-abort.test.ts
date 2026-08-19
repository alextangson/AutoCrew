/**
 * runLoop 中止链路（对话控制面设计 §Phase 3「turn 寻址与中止链路」）。
 *
 * 断的是不变量，不是文案：中止走正常返回（stopReason="aborted"，不 throw）、
 * 已执行的工具产出保留、剩余工具跳过、模型调用前的检查点生效。
 */
import { describe, it, expect, afterAll } from "vitest";
import { runLoop, type LoopTool } from "./loop.js";
import { shutdownObserver } from "./observer.js";
import { openaiSse, sseResponse } from "./sse-fixtures.js";
import type { EngineConfig } from "./config.js";

const CFG: EngineConfig = { apiKey: "sk-test", baseUrl: "https://fake.local", strongModel: "m", fastModel: "f" };

afterAll(() => shutdownObserver());

function toolCallTurn(calls: Array<{ id: string; name: string; args: string }>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
        },
      },
    ],
    usage: { total_tokens: 10 },
  };
}

describe("runLoop 用户中止", () => {
  it("工具之间中止：已执行的工具保留结果，剩余工具跳过，正常返回 aborted", async () => {
    const ctrl = new AbortController();
    const ran: string[] = [];
    const mk = (name: string, onRun?: () => void): LoopTool => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: () => {
        ran.push(name);
        onRun?.();
        return `${name} done`;
      },
    });
    // 第一个工具跑完就中止 —— 后两个必须一个都不跑
    const tools = [mk("first", () => ctrl.abort()), mk("second"), mk("third")];

    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return sseResponse(
        openaiSse(
          toolCallTurn([
            { id: "c1", name: "first", args: "{}" },
            { id: "c2", name: "second", args: "{}" },
            { id: "c3", name: "third", args: "{}" },
          ]),
        ),
      );
    }) as typeof fetch;

    const res = await runLoop(CFG, {
      model: "f",
      systemPrompt: "s",
      userMessage: "u",
      tools,
      fetchImpl,
      signal: ctrl.signal,
    });

    expect(res.stopReason).toBe("aborted");
    expect(ran).toEqual(["first"]);
    expect(res.toolCallCount).toBe(1);
    expect(calls).toBe(1); // 中止后不再回模型要下一轮
  });

  it("模型调用前已中止：一次都不打模型，finalMessage 为空（不是「(no content)」）", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return sseResponse(openaiSse({ choices: [{ message: { content: "不该出现" } }], usage: { total_tokens: 1 } }));
    }) as typeof fetch;

    const res = await runLoop(CFG, {
      model: "f",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl,
      signal: ctrl.signal,
    });

    expect(res.stopReason).toBe("aborted");
    expect(res.finalMessage).toBe("");
    expect(res.turns).toBe(0);
    expect(calls).toBe(0);
  });

  it("中止时已有助手文本就保留它（finalMessage 不被清空）", async () => {
    const ctrl = new AbortController();
    const tools: LoopTool[] = [
      {
        name: "slow",
        description: "slow",
        parameters: { type: "object", properties: {} },
        execute: () => {
          ctrl.abort();
          return "ok";
        },
      },
    ];
    const fetchImpl = (async () =>
      sseResponse(
        openaiSse({
          choices: [
            {
              message: {
                content: "我先说一句，然后去干活",
                tool_calls: [{ id: "c1", function: { name: "slow", arguments: "{}" } }],
              },
            },
          ],
          usage: { total_tokens: 5 },
        }),
      )) as typeof fetch;

    const res = await runLoop(CFG, { model: "f", systemPrompt: "s", userMessage: "u", tools, fetchImpl, signal: ctrl.signal });
    expect(res.stopReason).toBe("aborted");
    expect(res.finalMessage).toBe("我先说一句，然后去干活");
  });

  it("传输中中止：观察器掐流，withRetry 不重放，仍走 aborted 正常出口", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    // 上游只发头、不发体，等中止信号到了才 error —— 模拟「模型正在慢慢吐字时用户点了停」
    const fetchImpl = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls++;
      const stream = new ReadableStream({
        start(c) {
          init?.signal?.addEventListener("abort", () => c.error(new Error("aborted by user")));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const run = runLoop(CFG, { model: "f", systemPrompt: "s", userMessage: "u", fetchImpl, signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const res = await run;
    expect(res.stopReason).toBe("aborted");
    expect(calls).toBe(1); // 中止的失败不进重试通道
  });
});
