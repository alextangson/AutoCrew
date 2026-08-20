/**
 * 右栏模型切换器 — 档位解析（resolveChatModel）、可选清单（chatModelOptions /
 * chat:model_options）、以及 runChatTurn 真按选中的端点+模型发请求。
 *
 * 两条红线在这里钉死：
 *   1. 选项清单绝不带 apiKey/baseUrl（它要过 IPC 到浏览器）。
 *   2. 点名备用端点 = 没有"备用的备用"，打不通就报错，不许绕回主端点。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chatModelOptions, resolveChatModel, runChatTurn } from "./chat-router.js";
import { buildIpcHandlers } from "./ipc.js";
import { openaiSseResponse, bodyText } from "../engine/sse-fixtures.js";
import type { EngineConfig } from "../engine/config.js";

const PRIMARY: EngineConfig = {
  apiKey: "primary-key",
  baseUrl: "https://primary.local",
  strongModel: "claude-opus-4-8",
  fastModel: "claude-sonnet-5",
  protocol: "anthropic",
};

const WITH_FALLBACK: EngineConfig = {
  ...PRIMARY,
  fallback: {
    baseUrl: "https://backup.local",
    apiKey: "backup-key",
    strongModel: "deepseek-v4-pro",
    fastModel: "deepseek-v4-flash",
    protocol: "openai",
  },
};

describe("resolveChatModel", () => {
  it("缺省与 fast 字面等于今天：主端点快档，引擎级 fallback 链原样保留", () => {
    for (const choice of [undefined, "fast"]) {
      const r = resolveChatModel(WITH_FALLBACK, choice);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.model).toBe("claude-sonnet-5");
      expect(r.config).toBe(WITH_FALLBACK); // 同一个对象，一个字段都没动
      expect(r.config.fallback).toBeDefined();
    }
  });

  it("strong 走主端点强档，兜底链照常在", () => {
    const r = resolveChatModel(WITH_FALLBACK, "strong");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.config.baseUrl).toBe("https://primary.local");
    expect(r.config.fallback).toBeDefined();
  });

  it("fallback_fast / fallback_strong 换端点+凭证+协议，且不再带二级 fallback", () => {
    const fast = resolveChatModel(WITH_FALLBACK, "fallback_fast");
    expect(fast.ok).toBe(true);
    if (!fast.ok) return;
    expect(fast.model).toBe("deepseek-v4-flash");
    expect(fast.config.baseUrl).toBe("https://backup.local");
    expect(fast.config.apiKey).toBe("backup-key");
    expect(fast.config.protocol).toBe("openai");
    // 用户点名了备用端点：失败就如实报错，不许再绕回主端点
    expect(fast.config.fallback).toBeUndefined();

    const strong = resolveChatModel(WITH_FALLBACK, "fallback_strong");
    expect(strong.ok).toBe(true);
    if (!strong.ok) return;
    expect(strong.model).toBe("deepseek-v4-pro");
    expect(strong.config.fallback).toBeUndefined();
  });

  it("点了备用但没配备用：显式报错，不静默降级到主端点", () => {
    const r = resolveChatModel(PRIMARY, "fallback_strong");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("该模型未配置");
  });

  it("非法值报错且清洗掉本地路径，不回落成某个能跑的模型", () => {
    const r = resolveChatModel(WITH_FALLBACK, "/Users/somebody/secret 的模型");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("该模型未配置");
    expect(r.error).not.toContain("/Users/somebody");
  });
});

describe("chatModelOptions", () => {
  it("无备用端点时只有主端点两档", () => {
    expect(chatModelOptions(PRIMARY)).toEqual([
      { id: "fast", model: "claude-sonnet-5", tier: "快" },
      { id: "strong", model: "claude-opus-4-8", tier: "强" },
    ]);
  });

  it("配了备用端点就多出两档，显示的是备用端点自己的模型名", () => {
    expect(chatModelOptions(WITH_FALLBACK).map((o) => o.id)).toEqual([
      "fast", "strong", "fallback_fast", "fallback_strong",
    ]);
    expect(chatModelOptions(WITH_FALLBACK)[3]).toEqual({
      id: "fallback_strong", model: "deepseek-v4-pro", tier: "备用强",
    });
  });

  it("清单里没有任何凭证字段——它要过 IPC 到浏览器", () => {
    const serialized = JSON.stringify(chatModelOptions(WITH_FALLBACK));
    expect(serialized).not.toContain("primary-key");
    expect(serialized).not.toContain("backup-key");
    expect(serialized).not.toContain("backup.local");
    for (const option of chatModelOptions(WITH_FALLBACK)) {
      expect(Object.keys(option).sort()).toEqual(["id", "model", "tier"]);
    }
  });
});

describe("chat:model_options 通道", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-model-options-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    vi.unstubAllEnvs();
  });

  const call = () => buildIpcHandlers()["chat:model_options"]({ _dataDir: testDir });

  it("有备用端点：四档，且响应里没有 key/baseUrl", async () => {
    await fs.writeFile(
      path.join(testDir, "engine.json"),
      JSON.stringify({
        apiKey: "primary-key",
        baseUrl: "https://primary.local",
        strongModel: "claude-opus-4-8",
        fastModel: "claude-sonnet-5",
        fallback: {
          baseUrl: "https://backup.local",
          apiKey: "backup-key",
          strongModel: "deepseek-v4-pro",
          fastModel: "deepseek-v4-flash",
        },
      }),
    );
    const res = await call();
    expect(res.ok).toBe(true);
    const options = (res.data as { options: Array<Record<string, string>> }).options;
    expect(options.map((o) => o.id)).toEqual(["fast", "strong", "fallback_fast", "fallback_strong"]);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("primary-key");
    expect(serialized).not.toContain("backup-key");
    expect(serialized).not.toContain("primary.local");
  });

  it("没配备用端点：只有两档", async () => {
    await fs.writeFile(
      path.join(testDir, "engine.json"),
      JSON.stringify({ apiKey: "primary-key", baseUrl: "https://primary.local" }),
    );
    const res = await call();
    const options = (res.data as { options: Array<Record<string, string>> }).options;
    expect(options.map((o) => o.id)).toEqual(["fast", "strong"]);
  });

  it("引擎没配置：回空清单（前端据此隐藏切换器），不是错误", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const res = await call();
    expect(res).toEqual({ ok: true, data: { options: [] } });
  });
});

describe("runChatTurn modelChoice", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-model-turn-"));
    await fs.writeFile(
      path.join(testDir, "engine.json"),
      JSON.stringify({
        apiKey: "primary-key",
        baseUrl: "https://primary.local",
        strongModel: "primary-strong",
        fastModel: "primary-fast",
        protocol: "openai",
        fallback: {
          baseUrl: "https://backup.local",
          apiKey: "backup-key",
          strongModel: "backup-strong",
          fastModel: "backup-fast",
          protocol: "openai",
        },
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  /** 捕获实际发出去的 URL 与 body.model */
  function capturingFetch(seen: Array<{ url: string; model: unknown }>): typeof fetch {
    return (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init as { body?: unknown })) as { model?: unknown };
      seen.push({ url: String(url), model: body.model });
      return openaiSseResponse({
        choices: [{ message: { role: "assistant", content: "好了" } }],
        usage: { total_tokens: 5 },
      } as never);
    }) as typeof fetch;
  }

  it("不传档位 = 主端点快档（今天的行为）", async () => {
    const seen: Array<{ url: string; model: unknown }> = [];
    const res = await runChatTurn({ message: "你好", dataDir: testDir, fetchImpl: capturingFetch(seen) });
    expect(res.ok).toBe(true);
    expect(seen[0].model).toBe("primary-fast");
    expect(seen[0].url).toContain("primary.local");
  });

  it("strong 走主端点强档", async () => {
    const seen: Array<{ url: string; model: unknown }> = [];
    await runChatTurn({ message: "你好", dataDir: testDir, modelChoice: "strong", fetchImpl: capturingFetch(seen) });
    expect(seen[0].model).toBe("primary-strong");
    expect(seen[0].url).toContain("primary.local");
  });

  it("fallback_strong 真打到备用端点、用备用强档", async () => {
    const seen: Array<{ url: string; model: unknown }> = [];
    await runChatTurn({
      message: "你好", dataDir: testDir, modelChoice: "fallback_strong", fetchImpl: capturingFetch(seen),
    });
    expect(seen[0].model).toBe("backup-strong");
    expect(seen[0].url).toContain("backup.local");
  });

  it("非法档位当场失败，一个请求都不发", async () => {
    const seen: Array<{ url: string; model: unknown }> = [];
    const res = await runChatTurn({
      message: "你好", dataDir: testDir, modelChoice: "turbo", fetchImpl: capturingFetch(seen),
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("该模型未配置");
    expect(seen).toHaveLength(0);
  });
});
