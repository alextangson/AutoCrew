/**
 * 引擎级备用模型路由：主端点重试烧完 → 切 DeepSeek 官方端点顶完本次调用。
 *
 * 走真 withRetry + 真观察器 + 真 pi-ai 解析，只把上游换成两条假腿（按 URL 分流），
 * 断的是红线不变量：切换绝不静默（fallback 事件 + run-log 两端留痕）、
 * 非可重试错误与用户中止一律不碰备用腿、两端都倒时两条原因都端出来。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { runLoop, type LoopEvent, type LoopStreamEvent } from "./loop.js";
import { shutdownObserver } from "./observer.js";
import { openaiSse, openaiSseTextParts, sseResponse } from "./sse-fixtures.js";
import { readRun } from "../runtime/run-log.js";
import type { EngineConfig } from "./config.js";

const PRIMARY = "https://primary.invalid";
const FALLBACK = "https://fallback.invalid";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-fallback-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterAll(() => shutdownObserver());

function cfg(withFallback = true): EngineConfig {
  return {
    apiKey: "sk-primary",
    baseUrl: PRIMARY,
    strongModel: "main-strong",
    fastModel: "main-fast",
    dataDir: dir,
    ...(withFallback
      ? {
          fallback: {
            baseUrl: FALLBACK,
            apiKey: "sk-deepseek-fake",
            strongModel: "deepseek-v4-pro",
            fastModel: "deepseek-v4-flash",
            protocol: "openai" as const,
          },
        }
      : {}),
  };
}

interface Legs {
  primary: number;
  fallback: number;
  /** 备用腿收到的凭证（观察器透传的请求头）——证明换的是端点+key，不只是模型名 */
  fallbackAuth: string[];
}

/** 按上游 URL 分流的双腿夹具：观察器把 upstreamBase 原样带到 fetchImpl */
function twoLegs(
  primary: (n: number) => Response | Promise<Response>,
  fallback: (n: number) => Response | Promise<Response>,
): { impl: typeof fetch; legs: Legs } {
  const legs: Legs = { primary: 0, fallback: 0, fallbackAuth: [] };
  const impl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    if (String(url).startsWith(FALLBACK)) {
      legs.fallbackAuth.push(init?.headers?.authorization ?? init?.headers?.["x-api-key"] ?? "");
      return fallback(++legs.fallback);
    }
    return primary(++legs.primary);
  }) as unknown as typeof fetch;
  return { impl, legs };
}

const rateLimited = () => new Response("rate limited", { status: 429 });
const reply = (text: string, tokens = 11) =>
  sseResponse(openaiSse({ choices: [{ message: { content: text } }], usage: { total_tokens: tokens } }));

/** 事件序列压成可断言的形状（与 loop-delta.test.ts 同一套） */
const shape = (events: LoopStreamEvent[]) => events.map((e) => (e.ev === "reset" ? "reset" : `delta:${e.text}`));

describe("主端点烧完 → 备用顶上", () => {
  it("主 429 耗尽后切备用：回复来自备用腿，fallback 事件已 emit，run-log 两端都有记录", async () => {
    const { impl, legs } = twoLegs(rateLimited, () => reply("备用模型顶上来的回答"));
    const events: LoopEvent[] = [];

    const res = await runLoop(cfg(), {
      model: "main-fast",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl: impl,
      retryMaxDelayMs: 5,
      onEvent: (e) => events.push(e),
      logMeta: { runId: "run-fb-ok", agent: "chief-editor" },
    });

    expect(res.finalMessage).toBe("备用模型顶上来的回答");
    expect(legs.primary).toBe(4); // 首发 + 3 次重试全烧完才换端点
    expect(legs.fallback).toBe(1);
    expect(legs.fallbackAuth[0]).toContain("sk-deepseek-fake"); // 用的是备用端点自己的 key
    // 红线之一：切换必须冒泡到调用方（chat 进度条的事实源）
    expect(events).toEqual([{ type: "fallback", from: "main-fast", to: "deepseek-v4-flash" }]);

    await new Promise((r) => setTimeout(r, 60));
    const records = await readRun(dir, "run-fb-ok");
    // 红线之二：run-log 两端都留痕——失败的主调用不许被成功的备用调用盖掉
    expect(records.map((r) => ({ name: r.name, ok: r.ok }))).toEqual([
      { name: "main-fast", ok: false },
      { name: "deepseek-v4-flash", ok: true },
    ]);
    expect(records[0].error).toMatch(/429/);
    expect(records[1].output).toContain("备用模型顶上来的回答");
  });

  it("备用腿也说自己的方言：备用回复照常经历工具往返（切换只换端点，不改编排）", async () => {
    let fbCall = 0;
    const { impl, legs } = twoLegs(rateLimited, () => {
      fbCall++;
      if (fbCall === 1) {
        return sseResponse(
          openaiSse({
            choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "echo", arguments: "{}" } }] } }],
            usage: { total_tokens: 4 },
          }),
        );
      }
      return reply("查完了");
    });

    const res = await runLoop(cfg(), {
      model: "main-strong",
      systemPrompt: "s",
      userMessage: "u",
      tools: [{ name: "echo", description: "echo", parameters: { type: "object", properties: {} }, execute: () => "回声" }],
      fetchImpl: impl,
      retryMaxDelayMs: 5,
    });

    expect(res.toolCallCount).toBe(1);
    expect(res.finalMessage).toBe("查完了");
    // 第二轮从主端点重新开始（fallback 是 per-call 的救火，不是本轮之后的粘性切换）
    expect(legs.primary).toBe(8);
    expect(legs.fallback).toBe(2);
  });

  it("强档映射：route 专属模型走备用强档（宁强勿弱）", async () => {
    const events: LoopEvent[] = [];
    const { impl } = twoLegs(rateLimited, () => reply("强档接手"));
    await runLoop(cfg(), {
      model: "claude-opus-4-8", // writer route 的专属模型：既不是 fastModel 也不是 strongModel
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl: impl,
      retryMaxDelayMs: 5,
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([{ type: "fallback", from: "claude-opus-4-8", to: "deepseek-v4-pro" }]);
  });
});

describe("不该切的时候一步都不切", () => {
  it("主 401：非可重试错误换端点也是错，备用腿计数为 0", async () => {
    const { impl, legs } = twoLegs(
      () => new Response("bad key", { status: 401 }),
      () => reply("不该出现"),
    );

    await expect(
      runLoop(cfg(), { model: "main-fast", systemPrompt: "s", userMessage: "u", fetchImpl: impl, retryMaxDelayMs: 5 }),
    ).rejects.toThrow(/401/);
    expect(legs.primary).toBe(1); // 401 连主端点自己都不重试
    expect(legs.fallback).toBe(0);
  });

  it("用户中止：中止长得像瞬时故障，但绝不许偷偷再叫一次模型", async () => {
    const ctrl = new AbortController();
    const events: LoopEvent[] = [];
    const { impl, legs } = twoLegs(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              ctrl.signal.addEventListener("abort", () => c.error(new Error("aborted by user")));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      () => reply("不该出现"),
    );

    const run = runLoop(cfg(), {
      model: "main-fast",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl: impl,
      retryMaxDelayMs: 5,
      signal: ctrl.signal,
      onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    const res = await run;
    expect(res.stopReason).toBe("aborted");
    expect(legs.primary).toBe(1);
    expect(legs.fallback).toBe(0);
    expect(events).toEqual([]);
  });

  it("没配备用：主端点失败原样抛（additive 扩展不改既有工作区的行为）", async () => {
    const { impl, legs } = twoLegs(rateLimited, () => reply("不该出现"));
    await expect(
      runLoop(cfg(false), { model: "main-fast", systemPrompt: "s", userMessage: "u", fetchImpl: impl, retryMaxDelayMs: 5 }),
    ).rejects.toThrow(/429/);
    expect(legs.primary).toBe(4);
    expect(legs.fallback).toBe(0);
  });
});

describe("两端都倒", () => {
  it("组合错误同时带主/备两端的原因，原始病根不被备用的错误盖掉", async () => {
    const { impl, legs } = twoLegs(rateLimited, () => new Response("upstream boom", { status: 500 }));

    await expect(
      runLoop(cfg(), {
        model: "main-fast",
        systemPrompt: "s",
        userMessage: "u",
        fetchImpl: impl,
        retryMaxDelayMs: 5,
        logMeta: { runId: "run-fb-both" },
      }),
    ).rejects.toThrow(/主端点:.*429[\s\S]*备用端点\(deepseek\):.*500/);
    expect(legs.primary).toBe(4);
    expect(legs.fallback).toBe(2); // 备用只给一次重试机会

    await new Promise((r) => setTimeout(r, 60));
    const records = await readRun(dir, "run-fb-both");
    expect(records).toHaveLength(1);
    expect(records[0].ok).toBe(false);
    expect(records[0].error).toMatch(/主端点/);
    expect(records[0].error).toMatch(/备用端点/);
  });
});

describe("流式语义在备用腿同样成立", () => {
  it("主端点吐了半句才断：备用 attempt 开头照样先 reset，屏幕上不会两段话拼一起", async () => {
    const events: LoopStreamEvent[] = [];
    const half = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "半句话就" } }] })}\n\n`;
    const { impl } = twoLegs(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(half));
              setTimeout(() => c.error(new Error("terminated")), 10);
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      () => sseResponse(openaiSseTextParts(["备用接手", "把话说完"])),
    );

    const res = await runLoop(cfg(), {
      model: "main-fast",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl: impl,
      retryMaxDelayMs: 5,
      onTextDelta: (e) => events.push(e),
    });

    expect(shape(events)).toEqual([
      ...Array.from({ length: 4 }, () => ["reset", "delta:半句话就"]).flat(), // 主端点 4 次 attempt
      "reset", // 备用 attempt 也是新 attempt：前面的半句先作废
      "delta:备用接手",
      "delta:把话说完",
    ]);
    expect(res.finalMessage).toBe("备用接手把话说完");
  });
});
