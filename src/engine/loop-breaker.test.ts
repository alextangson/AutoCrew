/**
 * 引擎熔断与回退可见（P6 spec §3.9；eval `dead-main-no-wait` / `fallback-visible`）。
 *
 * 走真 withRetry + 真观察器 + 真 pi-ai 解析（与 loop-health.test.ts 同一套双腿夹具），
 * 健康证据是手写的 engine-health.json（5 分钟前的失败），断的是：
 * 死线路一个字节都不发、全死立即报 engine_unavailable、每次换线都在 run-log 与计数里看得见。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { runLoop, type LoopEvent } from "./loop.js";
import { EngineUnavailableError, trippedReason } from "./breaker.js";
import { setEngineFallbackSink, setEngineHealthSink, type EngineFallbackRecord, type EngineLiveRecord } from "./health-sink.js";
import { shutdownObserver } from "./observer.js";
import { bodyText, openaiSse, sseResponse } from "./sse-fixtures.js";
import { flushRunLogs, readRun } from "../runtime/run-log.js";
import type { EngineConfig } from "./config.js";

const PRIMARY = "https://primary.invalid";
const FALLBACK = "https://fallback.invalid";
const MIN = 60_000;

let dir: string;
let fallbacks: EngineFallbackRecord[];
let lives: EngineLiveRecord[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-breaker-"));
  fallbacks = [];
  lives = [];
  setEngineFallbackSink((r) => fallbacks.push(r));
  setEngineHealthSink((r) => lives.push(r));
});

afterEach(async () => {
  setEngineFallbackSink(undefined);
  setEngineHealthSink(undefined);
  await flushRunLogs(); // 迟到的追加会在 rm 途中重建 logs/runs
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
      { id: "newcli", name: "newcli", baseUrl: PRIMARY, apiKey: "sk-primary", protocol: "openai", models: ["main-strong"] },
      { id: "deepseek", name: "DeepSeek", baseUrl: FALLBACK, apiKey: "sk-fb", protocol: "openai", models: ["deepseek-v4-pro"] },
    ],
    ...(withFallback
      ? { fallback: { baseUrl: FALLBACK, apiKey: "sk-fb", strongModel: "deepseek-v4-pro", fastModel: "deepseek-v4-flash", protocol: "openai" as const } }
      : {}),
  };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** 手写健康文件：与桌面层 saveHealthState 落的形状一致 */
async function writeHealth(providers: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(dir, "engine-health.json"), JSON.stringify({ providers }), "utf-8");
}

function twoLegs(primary: () => Response, fallback: () => Response) {
  const legs = { primary: 0, fallback: 0 };
  const impl = (async (url: unknown, init?: { body?: unknown }) => {
    JSON.parse(bodyText(init));
    if (String(url).startsWith(FALLBACK)) {
      legs.fallback += 1;
      return fallback();
    }
    legs.primary += 1;
    return primary();
  }) as unknown as typeof fetch;
  return { impl, legs };
}

const reply = (text: string) => sseResponse(openaiSse({ choices: [{ message: { content: text } }], usage: { total_tokens: 7 } }));
const rateLimited = () => new Response("rate limited", { status: 429 });
const deadLive = (at: string) => ({ live: { at, ok: false, role: "writer", error: "写稿专线 newcli 连不上：网络不通或域名解析失败。" } });

async function fallbackRecords(runId: string) {
  // run-log 是 fire-and-forget 追加：等在途写落定再读，固定延时在负载下不够
  await flushRunLogs();
  return (await readRun(dir, runId)).filter((r) => r.kind === "fallback");
}

describe("熔断：死线路不占用等待（dead-main-no-wait）", () => {
  it("主端点 5 分钟前刚失败：一个请求都不发给它，直接交给备用；换线三处可见", async () => {
    await writeHealth({ newcli: deadLive(ago(5 * MIN)) });
    const { impl, legs } = twoLegs(() => reply("不该出现"), () => reply("备用顶上"));
    const events: LoopEvent[] = [];
    const res = await runLoop(cfg(true), {
      model: "main-strong", systemPrompt: "s", userMessage: "u", fetchImpl: impl,
      onEvent: (e) => events.push(e), logMeta: { runId: "run-skip" },
    });
    expect(res.finalMessage).toBe("备用顶上");
    expect(legs).toEqual({ primary: 0, fallback: 1 });
    expect(res.usedFallback?.error).toMatch(/^熔断跳过：写稿专线 newcli 连不上/);
    expect(events[0]).toMatchObject({ type: "fallback", fromProvider: "newcli", toProvider: "deepseek" });
    expect(fallbacks).toEqual([{ from: "newcli", to: "deepseek", reason: expect.stringMatching(/熔断跳过/), skipped: true }]);
    expect(await fallbackRecords("run-skip")).toEqual([
      expect.objectContaining({ kind: "fallback", from: "newcli", to: "deepseek", skipped: true, ok: true, reason: expect.stringMatching(/连不上/) }),
    ]);
    // 被跳过的线没有新的 live 记录——它没被调用，谈不上成败
    expect(lives.map((l) => `${l.providerId}:${l.ok}`)).toEqual(["deepseek:true"]);
  });

  it("全部熔断：立即抛 engine_unavailable，零请求、不等超时，每条被跳过的线各记一笔", async () => {
    await writeHealth({
      newcli: deadLive(ago(5 * MIN)),
      deepseek: { probe: { at: ago(2 * MIN), ok: false, ms: 20_000, error: "端点 deepseek 响应超时" } },
    });
    const { impl, legs } = twoLegs(() => reply("不该出现"), () => reply("不该出现"));
    const started = Date.now();
    const err = await runLoop(cfg(true), { model: "main-strong", systemPrompt: "s", userMessage: "u", fetchImpl: impl, logMeta: { runId: "run-dead" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as EngineUnavailableError).code).toBe("engine_unavailable");
    expect((err as Error).message).toMatch(/newcli：写稿专线[\s\S]*deepseek：端点 deepseek 响应超时/);
    expect(legs).toEqual({ primary: 0, fallback: 0 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fallbacks.map((f) => `${f.from}→${f.to}:${f.skipped}`)).toEqual(["newcli→none:true", "deepseek→none:true"]);
    const recorded = await fallbackRecords("run-dead");
    expect(recorded.map((r) => `${r.from}→${r.to}:${r.ok}`)).toEqual(["newcli→none:false", "deepseek→none:false"]);
  });

  it("没配备用、主端点熔断：同样立即报错，不发请求", async () => {
    await writeHealth({ newcli: deadLive(ago(1 * MIN)) });
    const { impl, legs } = twoLegs(() => reply("不该出现"), () => reply("不该出现"));
    await expect(runLoop(cfg(false), { model: "main-strong", systemPrompt: "s", userMessage: "u", fetchImpl: impl }))
      .rejects.toBeInstanceOf(EngineUnavailableError);
    expect(legs.primary).toBe(0);
  });

  it("主端点健康、备用熔断：主端点失败后不碰备用，原样抛主端点的错并记一笔跳过", async () => {
    await writeHealth({ deepseek: deadLive(ago(3 * MIN)) });
    const { impl, legs } = twoLegs(rateLimited, () => reply("不该出现"));
    await expect(runLoop(cfg(true), { model: "main-strong", systemPrompt: "s", userMessage: "u", fetchImpl: impl, retryMaxDelayMs: 5 }))
      .rejects.toThrow(/429/);
    expect(legs.fallback).toBe(0);
    expect(fallbacks).toEqual([expect.objectContaining({ from: "deepseek", to: "none", skipped: true })]);
  });
});

describe("熔断只认最近、线路级、10 分钟内的失败", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["失败已过 10 分钟（半开：再试一次）", deadLive(ago(11 * MIN))],
    ["探针 5 分钟前失败，但 1 分钟前真实调用成功了", { probe: { at: ago(5 * MIN), ok: false, ms: 1, error: "x" }, live: { at: ago(1 * MIN), ok: true, role: "writer" } }],
    ["最近一次失败是请求本身的错（400），线路是通的", { live: { at: ago(1 * MIN), ok: false, role: "writer", error: "400", lineFault: false } }],
  ];
  for (const [name, entry] of cases) {
    it(`${name} → 照常调主端点`, async () => {
      await writeHealth({ newcli: entry });
      const { impl, legs } = twoLegs(() => reply("主端点"), () => reply("不该出现"));
      const res = await runLoop(cfg(true), { model: "main-strong", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
      expect(res.finalMessage).toBe("主端点");
      expect(legs).toEqual({ primary: 1, fallback: 0 });
      expect(fallbacks).toEqual([]);
    });
  }

  it("健康文件缺失或损坏 = 都当健康（观测层不得弄死执行层）", async () => {
    await fs.writeFile(path.join(dir, "engine-health.json"), "{ 坏的", "utf-8");
    const { impl, legs } = twoLegs(() => reply("主端点"), () => reply("不该出现"));
    await runLoop(cfg(true), { model: "main-strong", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
    expect(legs.primary).toBe(1);
    expect(trippedReason(undefined)).toBeNull();
  });

  it("失败回执带 lineFault：429 是线路级，熔断据此判", async () => {
    const { impl } = twoLegs(rateLimited, () => reply("备用"));
    await runLoop(cfg(true), { model: "main-strong", systemPrompt: "s", userMessage: "u", fetchImpl: impl, retryMaxDelayMs: 5 });
    expect(lives[0]).toMatchObject({ providerId: "newcli", ok: false, lineFault: true });
  });
});

describe("回退可见（fallback-visible）", () => {
  it("主端点真失败、备用顶上：run-log 一条 fallback（不是熔断），计数 +1", async () => {
    const { impl, legs } = twoLegs(rateLimited, () => reply("备用顶上"));
    await runLoop(cfg(true), { model: "main-strong", systemPrompt: "s", userMessage: "u", fetchImpl: impl, retryMaxDelayMs: 5, logMeta: { runId: "run-fb", agent: "writer" } });
    expect(legs.fallback).toBe(1);
    expect(fallbacks).toEqual([{ from: "newcli", to: "deepseek", reason: expect.stringMatching(/429/), skipped: false }]);
    const [rec] = await fallbackRecords("run-fb");
    expect(rec).toMatchObject({ kind: "fallback", agent: "writer", name: "fallback", action: "newcli→deepseek", ok: true });
    expect(rec).not.toHaveProperty("skipped");
  });
});
