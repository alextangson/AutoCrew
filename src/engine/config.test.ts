import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEngineConfig, resolveEngineRoute, resolveFallbackModel, type EngineConfig } from "./config.js";

let testDir: string;
const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-engine-test-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadEngineConfig", () => {
  it("reads engine.json from dataDir with full precedence", async () => {
    await fs.writeFile(
      path.join(testDir, "engine.json"),
      JSON.stringify({ apiKey: "sk-file", baseUrl: "https://relay.example.com", strongModel: "m-strong", fastModel: "m-fast" }),
    );
    process.env.DEEPSEEK_API_KEY = "sk-env";
    const c = await loadEngineConfig(testDir);
    expect(c.apiKey).toBe("sk-file");
    expect(c.baseUrl).toBe("https://relay.example.com");
    expect(c.strongModel).toBe("m-strong");
  });

  it("falls back to env with DeepSeek defaults", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-env";
    const c = await loadEngineConfig(testDir);
    expect(c.apiKey).toBe("sk-env");
    expect(c.baseUrl).toBe("https://api.deepseek.com");
    expect(c.strongModel).toBe("deepseek-v4-pro");
    expect(c.fastModel).toBe("deepseek-v4-flash");
  });

  it("partial engine.json merges over env/defaults", async () => {
    await fs.writeFile(path.join(testDir, "engine.json"), JSON.stringify({ strongModel: "m-x" }));
    process.env.DEEPSEEK_API_KEY = "sk-env";
    const c = await loadEngineConfig(testDir);
    expect(c.apiKey).toBe("sk-env");
    expect(c.strongModel).toBe("m-x");
  });

  it("loads task routes and shares the primary API key", async () => {
    await fs.writeFile(
      path.join(testDir, "engine.json"),
      JSON.stringify({
        apiKey: "sk-shared",
        baseUrl: "https://relay.example.com",
        strongModel: "main-strong",
        fastModel: "main-fast",
        routes: {
          writer: {
            baseUrl: "https://code.newcli.com/claude/ultra/",
            model: "claude-opus-4-8",
          },
          scout: {
            baseUrl: "https://code.newcli.com/claude/ultra/",
            model: "claude-sonnet-5",
          },
          codex: {
            baseUrl: "https://code.newcli.com/codex/v1/",
            model: "gpt-5.6-sol",
            models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
          },
        },
      }),
    );
    const config = await loadEngineConfig(testDir);
    const writer = resolveEngineRoute(config, "writer", config.strongModel);
    expect(writer.model).toBe("claude-opus-4-8");
    expect(writer.config.baseUrl).toBe("https://code.newcli.com/claude/ultra");
    expect(writer.config.protocol).toBe("anthropic");
    expect(writer.config.apiKey).toBe("sk-shared");
    expect(config.routes?.codex?.models).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(config.routes?.scout?.model).toBe("claude-sonnet-5");
  });

  it("throws actionable error when no key anywhere", async () => {
    await expect(loadEngineConfig(testDir)).rejects.toThrow(/DEEPSEEK_API_KEY|engine\.json/);
  });

  it("throws a pointing error when engine.json is malformed", async () => {
    await fs.writeFile(path.join(testDir, "engine.json"), "{broken");
    await expect(loadEngineConfig(testDir)).rejects.toThrow(/engine\.json 解析失败/);
  });

  it("throws when engine.json is literal null", async () => {
    await fs.writeFile(path.join(testDir, "engine.json"), "null");
    await expect(loadEngineConfig(testDir)).rejects.toThrow(/不是 JSON 对象/);
  });
});

// ─── 协议自动识别（Claude 系中转）────────────────────────────────────────────

describe("protocol auto-detect", () => {
  it("sk-ant key → anthropic;claude 域名 → anthropic;显式 protocol 覆盖;普通 → openai", async () => {
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "autocrew-proto-"));
    try {
      const write = (obj: Record<string, unknown>) =>
        fsp.writeFile(path.join(dir, "engine.json"), JSON.stringify(obj));

      await write({ apiKey: "sk-ant-xxx", baseUrl: "https://relay.example.com" });
      expect((await loadEngineConfig(dir)).protocol).toBe("anthropic");

      await write({ apiKey: "sk-plain", baseUrl: "https://code.newcli.com/claude/aws" });
      expect((await loadEngineConfig(dir)).protocol).toBe("anthropic");

      await write({ apiKey: "sk-ant-xxx", baseUrl: "https://x.com", protocol: "openai" });
      expect((await loadEngineConfig(dir)).protocol).toBe("openai");

      await write({ apiKey: "sk-plain", baseUrl: "https://api.deepseek.com" });
      expect((await loadEngineConfig(dir)).protocol).toBe("openai");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── 备用端点（主端点 429 烧完后顶上）────────────────────────────────────────

describe("fallback 配置解析", () => {
  const writeCfg = (obj: Record<string, unknown>) =>
    fs.writeFile(path.join(testDir, "engine.json"), JSON.stringify({ apiKey: "sk-main", baseUrl: "https://relay.example.com", ...obj }));

  it("完整块原样解析（含显式 protocol 与两档模型）", async () => {
    await writeCfg({
      fallback: { baseUrl: "https://api.deepseek.com/", apiKey: "sk-fb", strongModel: "ds-pro", fastModel: "ds-flash", protocol: "openai" },
    });
    const c = await loadEngineConfig(testDir);
    expect(c.fallback).toEqual({
      baseUrl: "https://api.deepseek.com", // 尾斜杠归一化，与 route 同规矩
      apiKey: "sk-fb",
      strongModel: "ds-pro",
      fastModel: "ds-flash",
      protocol: "openai",
    });
  });

  it("模型档位缺省 = DeepSeek 官方两档", async () => {
    await writeCfg({ fallback: { baseUrl: "https://api.deepseek.com", apiKey: "sk-fb" } });
    const c = await loadEngineConfig(testDir);
    expect(c.fallback?.strongModel).toBe("deepseek-v4-pro");
    expect(c.fallback?.fastModel).toBe("deepseek-v4-flash");
  });

  it("protocol 未填走推断：sk-ant 前缀 / claude 域名 → anthropic，其余 → openai", async () => {
    await writeCfg({ fallback: { baseUrl: "https://api.deepseek.com", apiKey: "sk-fb" } });
    expect((await loadEngineConfig(testDir)).fallback?.protocol).toBe("openai");

    await writeCfg({ fallback: { baseUrl: "https://relay.example.com", apiKey: "sk-ant-fb" } });
    expect((await loadEngineConfig(testDir)).fallback?.protocol).toBe("anthropic");

    await writeCfg({ fallback: { baseUrl: "https://x.example.com/claude/ultra", apiKey: "sk-fb" } });
    expect((await loadEngineConfig(testDir)).fallback?.protocol).toBe("anthropic");
  });

  it("缺 apiKey（或缺 baseUrl）→ 整块忽略并 warn 一行：半配的备用比没有更危险", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeCfg({ fallback: { baseUrl: "https://api.deepseek.com" } });
      expect((await loadEngineConfig(testDir)).fallback).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockClear();
      await writeCfg({ fallback: { apiKey: "sk-fb" } });
      expect((await loadEngineConfig(testDir)).fallback).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("没有 fallback 块 = 今天的行为，不 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeCfg({});
      expect((await loadEngineConfig(testDir)).fallback).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("route 继承顶层 fallback（本期不做 per-route 备用）", async () => {
    await writeCfg({
      routes: { writer: { baseUrl: "https://code.newcli.com/claude/ultra", model: "claude-opus-4-8" } },
      fallback: { baseUrl: "https://api.deepseek.com", apiKey: "sk-fb" },
    });
    const c = await loadEngineConfig(testDir);
    const writer = resolveEngineRoute(c, "writer", c.strongModel);
    expect(writer.config.fallback).toEqual(c.fallback);
    expect(resolveFallbackModel(writer.config, writer.model)).toBe("deepseek-v4-pro");
  });
});

describe("resolveFallbackModel", () => {
  const base: EngineConfig = {
    apiKey: "sk-main",
    baseUrl: "https://relay.example.com",
    strongModel: "main-strong",
    fastModel: "main-fast",
    fallback: { baseUrl: "https://api.deepseek.com", apiKey: "sk-fb", strongModel: "ds-pro", fastModel: "ds-flash", protocol: "openai" },
  };

  it("快档 → 备用快档；强档与 route 专属模型 → 备用强档（宁强勿弱）", () => {
    expect(resolveFallbackModel(base, "main-fast")).toBe("ds-flash");
    expect(resolveFallbackModel(base, "main-strong")).toBe("ds-pro");
    expect(resolveFallbackModel(base, "claude-opus-4-8")).toBe("ds-pro");
  });

  it("没配备用 → undefined（调用方据此不切换）", () => {
    const { fallback: _drop, ...noFallback } = base;
    expect(resolveFallbackModel(noFallback, "main-fast")).toBeUndefined();
  });
});

describe("multi-workspace engine.json fallback", () => {
  it("falls back to the default workspace's engine.json when the sub-workspace has none", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-cfg-ws-"));
    const saved = process.env.AUTOCREW_DATA_DIR;
    process.env.AUTOCREW_DATA_DIR = home;
    try {
      await fs.writeFile(path.join(home, "engine.json"), JSON.stringify({ apiKey: "sk-shared", baseUrl: "https://relay.example" }));
      const sub = path.join(home, "workspaces", "ws-muse");
      await fs.mkdir(sub, { recursive: true });

      const cfg = await loadEngineConfig(sub); // 子工作区无 engine.json → 回退默认
      expect(cfg.apiKey).toBe("sk-shared");
      expect(cfg.baseUrl).toBe("https://relay.example");
    } finally {
      if (saved === undefined) delete process.env.AUTOCREW_DATA_DIR;
      else process.env.AUTOCREW_DATA_DIR = saved;
      await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
