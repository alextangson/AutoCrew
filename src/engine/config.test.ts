import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEngineConfig } from "./config.js";

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

  it("throws actionable error when no key anywhere", async () => {
    await expect(loadEngineConfig(testDir)).rejects.toThrow(/DEEPSEEK_API_KEY|engine\.json/);
  });

  it("throws a pointing error when engine.json is malformed", async () => {
    await fs.writeFile(path.join(testDir, "engine.json"), "{broken");
    await expect(loadEngineConfig(testDir)).rejects.toThrow(/engine\.json 解析失败/);
  });
});
