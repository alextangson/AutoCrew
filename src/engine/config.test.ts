import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEngineConfig, resolveEngineRoute } from "./config.js";

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
  await fs.rm(testDir, { recursive: true, force: true });
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
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
