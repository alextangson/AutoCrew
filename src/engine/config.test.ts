import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadEngineConfig,
  normalizeProviders,
  resolveEngineConfigPath,
  resolveEngineRoute,
  resolveFallbackModel,
  type EngineConfig,
} from "./config.js";

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

// ─── 自定义端点（设计 §Phase 4：读取路径逐条 fail-closed）────────────────────

describe("normalizeProviders", () => {
  const good = {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/",
    apiKey: "sk-ds",
    models: ["deepseek-v4-pro", " deepseek-v4-flash "],
  };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("合法条目：尾斜杠归一化、模型 trim、name 缺省回落 id、协议自动推断", () => {
    expect(normalizeProviders([good])).toEqual([
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-ds",
        protocol: "openai",
        models: ["deepseek-v4-pro", "deepseek-v4-flash"],
      },
    ]);
    expect(normalizeProviders([{ ...good, name: "  " }])?.[0].name).toBe("deepseek");
    expect(normalizeProviders([{ ...good, apiKey: "sk-ant-x" }])?.[0].protocol).toBe("anthropic");
    expect(normalizeProviders([{ ...good, baseUrl: "https://x.com/claude/ultra" }])?.[0].protocol).toBe("anthropic");
    expect(normalizeProviders([{ ...good, protocol: "anthropic" }])?.[0].protocol).toBe("anthropic");
    expect(warn).not.toHaveBeenCalled();
  });

  it("localhost 显式放行（本地模型服务是常见形态）", () => {
    const r = normalizeProviders([{ ...good, id: "ollama", baseUrl: "http://localhost:11434/v1/" }]);
    expect(r?.[0].baseUrl).toBe("http://localhost:11434/v1");
  });

  it("id 不合法（大写/含冒号/空/超长/非字符串）逐条丢弃并 warn", () => {
    for (const id of ["DeepSeek", "deep:seek", "", "deep seek", "d".repeat(33), 42, undefined]) {
      expect(normalizeProviders([{ ...good, id }])).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(7);
  });

  it("baseUrl 各种坏形态都丢弃：非 http(s) / 带账密 / 带查询串 / 带锚点 / 非 URL / 缺失", () => {
    for (const baseUrl of [
      "ftp://api.deepseek.com",
      "file:///etc/passwd",
      "https://user:pass@api.deepseek.com",
      "https://api.deepseek.com/v1?key=abc",
      "https://api.deepseek.com/v1#frag",
      "api.deepseek.com",
      "",
      undefined,
    ]) {
      expect(normalizeProviders([{ ...good, baseUrl }])).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(8);
  });

  it("缺 apiKey / models 为空 / models 全是空串 → 丢弃", () => {
    expect(normalizeProviders([{ ...good, apiKey: "  " }])).toBeUndefined();
    expect(normalizeProviders([{ ...good, apiKey: undefined }])).toBeUndefined();
    expect(normalizeProviders([{ ...good, models: [] }])).toBeUndefined();
    expect(normalizeProviders([{ ...good, models: ["", "  "] }])).toBeUndefined();
    expect(normalizeProviders([{ ...good, models: "deepseek-v4-pro" }])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("重复 id：同 id 的条目**全部**失效（首赢末赢都是静默换端点），其余条目照常", () => {
    const r = normalizeProviders([
      { ...good, name: "甲" },
      { ...good, name: "乙", apiKey: "sk-other" },
      { ...good, id: "other", name: "丙" },
    ]);
    expect(r?.map((p) => p.id)).toEqual(["other"]);
    // 重复只 warn 一次,不刷屏
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("空数组 / 缺失 / null / 非数组 → undefined（切换器只剩四档，今天的行为）", () => {
    expect(normalizeProviders([])).toBeUndefined();
    expect(normalizeProviders(undefined)).toBeUndefined();
    expect(normalizeProviders(null)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(normalizeProviders({ deepseek: good })).toBeUndefined();
    expect(normalizeProviders([null, "x", 3])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("坏条目不拖垮好条目，也不 throw", () => {
    const r = normalizeProviders([{ id: "BAD" }, good, { ...good, id: "kimi", apiKey: "" }]);
    expect(r?.map((p) => p.id)).toEqual(["deepseek"]);
  });

  it("loadEngineConfig 挂上 providers（无 providers 的老配置读出来没有这个字段）", async () => {
    await fs.writeFile(
      path.join(testDir, "engine.json"),
      JSON.stringify({ apiKey: "sk-main", baseUrl: "https://relay.example.com", providers: [good] }),
    );
    const c = await loadEngineConfig(testDir);
    expect(c.providers?.map((p) => p.id)).toEqual(["deepseek"]);

    await fs.writeFile(path.join(testDir, "engine.json"), JSON.stringify({ apiKey: "sk-main" }));
    expect((await loadEngineConfig(testDir)).providers).toBeUndefined();
  });
});

describe("resolveEngineConfigPath", () => {
  it("有自己的 engine.json → 就是它；一个都没有 → 回本工作区路径（保存会写在这里）", async () => {
    expect(await resolveEngineConfigPath(testDir)).toBe(path.join(testDir, "engine.json"));
    await fs.writeFile(path.join(testDir, "engine.json"), JSON.stringify({ apiKey: "sk" }));
    expect(await resolveEngineConfigPath(testDir)).toBe(path.join(testDir, "engine.json"));
  });

  it("子工作区继承默认工作区时，返回**真实读到**的那一份（打开配置文件不能开空路径）", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-cfgpath-"));
    const savedEnv = process.env.AUTOCREW_DATA_DIR;
    process.env.AUTOCREW_DATA_DIR = home;
    try {
      await fs.writeFile(path.join(home, "engine.json"), JSON.stringify({ apiKey: "sk-shared" }));
      const sub = path.join(home, "workspaces", "ws-muse");
      await fs.mkdir(sub, { recursive: true });
      expect(await resolveEngineConfigPath(sub)).toBe(path.join(home, "engine.json"));

      // 子工作区自己有一份就用自己的
      await fs.writeFile(path.join(sub, "engine.json"), JSON.stringify({ apiKey: "sk-own" }));
      expect(await resolveEngineConfigPath(sub)).toBe(path.join(sub, "engine.json"));
    } finally {
      if (savedEnv === undefined) delete process.env.AUTOCREW_DATA_DIR;
      else process.env.AUTOCREW_DATA_DIR = savedEnv;
      await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
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
