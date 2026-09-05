/**
 * runLoop 的健康回执与兜底留痕（P2 spec §4.1 / §4.3）。
 *
 * 走真 withRetry + 真观察器 + 真 pi-ai 解析（与 loop-fallback.test.ts 同一套双腿夹具），
 * 断三件事：成功记一条 ok、失败记一条坏、兜底时主线失败与备用成功**各一条**，
 * 并且 `LoopResult.usedFallback` 存在（稿卡「备用顶上」徽章的数据来源）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { runLoop } from "./loop.js";
import { setEngineHealthSink, type EngineLiveRecord } from "./health-sink.js";
import { shutdownObserver } from "./observer.js";
import { bodyText, openaiSse, sseResponse } from "./sse-fixtures.js";
import type { EngineConfig } from "./config.js";

const PRIMARY = "https://primary.invalid";
const FALLBACK = "https://fallback.invalid";

let dir: string;
let records: EngineLiveRecord[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-health-loop-"));
  records = [];
  setEngineHealthSink((r) => records.push(r));
});

afterEach(async () => {
  setEngineHealthSink(undefined);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterAll(() => shutdownObserver());

function cfg(withFallback: boolean): EngineConfig {
  return {
    apiKey: "sk-primary",
    baseUrl: PRIMARY,
    strongModel: "main-strong",
    fastModel: "main-fast",
    dataDir: dir,
    activeProvider: { id: "newcli", role: "writer" },
    providers: [
      { id: "newcli", name: "newcli", baseUrl: PRIMARY, apiKey: "sk-primary", protocol: "openai", models: ["main-strong", "main-fast"] },
      { id: "deepseek", name: "DeepSeek", baseUrl: FALLBACK, apiKey: "sk-fb", protocol: "openai", models: ["deepseek-v4-pro"] },
    ],
    ...(withFallback
      ? { fallback: { baseUrl: FALLBACK, apiKey: "sk-fb", strongModel: "deepseek-v4-pro", fastModel: "deepseek-v4-flash", protocol: "openai" as const } }
      : {}),
  };
}

function twoLegs(primary: () => Response, fallback: () => Response): typeof fetch {
  return (async (url: unknown, init?: { body?: unknown }) => {
    JSON.parse(bodyText(init)); // 与生产同路：请求体必须是合法 JSON
    return String(url).startsWith(FALLBACK) ? fallback() : primary();
  }) as unknown as typeof fetch;
}

const reply = (text: string) =>
  sseResponse(openaiSse({ choices: [{ message: { content: text } }], usage: { total_tokens: 7 } }));
const rateLimited = () => new Response("rate limited", { status: 429 });

describe("runLoop → 健康回执", () => {
  it("成功：按 activeProvider 记一条 ok，带岗位与任务 id", async () => {
    await runLoop(cfg(false), {
      model: "main-strong",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl: twoLegs(() => reply("写好了"), () => reply("不该出现")),
      logMeta: { runId: "run-ok" },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ providerId: "newcli", ok: true, role: "writer", jobId: "run-ok" });
  });

  it("失败且没有备用：记一条坏的，带原始错误（翻译在消费侧做）", async () => {
    await expect(
      runLoop(cfg(false), {
        model: "main-strong",
        systemPrompt: "s",
        userMessage: "u",
        fetchImpl: twoLegs(rateLimited, () => reply("不该出现")),
        retryMaxDelayMs: 5,
      }),
    ).rejects.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ providerId: "newcli", ok: false, role: "writer" });
    expect(records[0].error).toMatch(/429/);
  });

  it("兜底：主线一条失败 + 备用一条成功，LoopResult.usedFallback 带全归因", async () => {
    const res = await runLoop(cfg(true), {
      model: "main-strong",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl: twoLegs(rateLimited, () => reply("备用顶上来的")),
      retryMaxDelayMs: 5,
      logMeta: { runId: "run-fb" },
    });
    expect(res.finalMessage).toBe("备用顶上来的");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ providerId: "newcli", ok: false, role: "writer", jobId: "run-fb" });
    expect(records[1]).toMatchObject({ providerId: "deepseek", ok: true, role: "writer", jobId: "run-fb" });
    expect(res.usedFallback).toMatchObject({ role: "writer", from: "main-strong", to: "deepseek-v4-pro" });
    expect(res.usedFallback?.error).toMatch(/429/);
  });

  it("两端都倒：两条都记坏，用户看得到主线与备用各自的病根", async () => {
    await expect(
      runLoop(cfg(true), {
        model: "main-strong",
        systemPrompt: "s",
        userMessage: "u",
        fetchImpl: twoLegs(rateLimited, () => new Response("bad gateway", { status: 502 })),
        retryMaxDelayMs: 5,
      }),
    ).rejects.toThrow(/主端点[\s\S]*备用端点/);
    expect(records.map((r) => `${r.providerId}:${r.ok}`)).toEqual(["newcli:false", "deepseek:false"]);
  });

  it("没人接 sink 时一切照常（engine 层不依赖 desktop）", async () => {
    setEngineHealthSink(undefined);
    const res = await runLoop(cfg(false), {
      model: "main-strong",
      systemPrompt: "s",
      userMessage: "u",
      fetchImpl: twoLegs(() => reply("照常"), () => reply("不该出现")),
    });
    expect(res.finalMessage).toBe("照常");
  });
});
