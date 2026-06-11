import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEngineSettings, setEngineSettings } from "./settings.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-settings-test-"));
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("DEEPSEEK_BASE_URL", "");
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("getEngineSettings", () => {
  it("reports unconfigured when no file and no env", async () => {
    const res = await getEngineSettings({ _dataDir: testDir });
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.configured).toBe(false);
    expect(d.source).toBe("none");
    expect(d.apiKeyMasked).toBeNull();
    expect(d.baseUrl).toBe("https://api.deepseek.com");
  });

  it("masks the key and never returns it raw", async () => {
    await fs.writeFile(
      path.join(testDir, "engine.json"),
      JSON.stringify({ apiKey: "sk-veryverysecret1234" }),
    );
    const res = await getEngineSettings({ _dataDir: testDir });
    const d = res.data as Record<string, unknown>;
    expect(d.configured).toBe(true);
    expect(d.source).toBe("file");
    expect(d.apiKeyMasked).toBe("sk-v…1234");
    expect(JSON.stringify(res)).not.toContain("veryverysecret");
  });
});

describe("setEngineSettings", () => {
  it("writes engine.json and merges partial updates", async () => {
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-abcdef12345678" });
    await setEngineSettings({ _dataDir: testDir, base_url: "https://relay.example.com" });

    const raw = JSON.parse(await fs.readFile(path.join(testDir, "engine.json"), "utf-8"));
    expect(raw.apiKey).toBe("sk-abcdef12345678");
    expect(raw.baseUrl).toBe("https://relay.example.com");

    const res = await getEngineSettings({ _dataDir: testDir });
    const d = res.data as Record<string, unknown>;
    expect(d.configured).toBe(true);
    expect(d.baseUrl).toBe("https://relay.example.com");
  });

  it("rejects empty api_key", async () => {
    const res = await setEngineSettings({ _dataDir: testDir, api_key: "   " });
    expect(res.ok).toBe(false);
  });
});
