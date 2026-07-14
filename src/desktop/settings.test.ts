import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEngineSettings, setEngineSettings, getPublishSettings, setPublishSettings } from "./settings.js";

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

  it("reads key from env when no file, masks it, source=env", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-envsecretkey9876");
    const res = await getEngineSettings({ _dataDir: testDir });
    const d = res.data as Record<string, unknown>;
    expect(d.configured).toBe(true);
    expect(d.source).toBe("env");
    expect(d.apiKeyMasked).toBe("sk-e…9876");
    expect(JSON.stringify(res)).not.toContain("envsecretkey");
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

  it("saves Opus writer/analytics routes and Codex choices without duplicating the key", async () => {
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-one-key-for-all" });
    const result = await setEngineSettings({
      _dataDir: testDir,
      writer_base_url: "https://code.newcli.com/claude/ultra",
      writer_model: "claude-opus-4-8",
      analytics_base_url: "https://code.newcli.com/claude/ultra",
      analytics_model: "claude-opus-4-8",
      scout_base_url: "https://code.newcli.com/claude/ultra",
      scout_model: "claude-sonnet-5",
      codex_base_url: "https://code.newcli.com/codex/v1",
      codex_model: "gpt-5.6-sol",
    });
    expect(result.ok).toBe(true);
    const raw = JSON.parse(await fs.readFile(path.join(testDir, "engine.json"), "utf-8"));
    expect(raw.routes.writer).toMatchObject({ model: "claude-opus-4-8", protocol: "anthropic" });
    expect(raw.routes.analytics).toMatchObject({ model: "claude-opus-4-8", protocol: "anthropic" });
    expect(raw.routes.scout).toMatchObject({ model: "claude-sonnet-5", protocol: "anthropic" });
    expect(raw.routes.codex.models).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(raw.routes.writer.apiKey).toBeUndefined();

    const read = await getEngineSettings({ _dataDir: testDir });
    expect(JSON.stringify(read)).not.toContain("one-key-for-all");
  });

  it("rejects empty api_key", async () => {
    const res = await setEngineSettings({ _dataDir: testDir, api_key: "   " });
    expect(res.ok).toBe(false);
  });

  it("tightens permissions to 0600 even when file pre-exists with looser mode", async () => {
    const filePath = path.join(testDir, "engine.json");
    await fs.writeFile(filePath, JSON.stringify({ apiKey: "sk-old" }), { mode: 0o644 });
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-new12345678" });
    const mode = (await fs.stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("publish settings 公众号绑定(可视化配置)", () => {
  it("写 appid/secret/留言开关 → 读回掩码与状态,secret 永不回显", async () => {
    const w = await setPublishSettings({
      wechat_app_id: "wx1234567890abcdef",
      wechat_app_secret: "supersecretvalue42",
      open_comment: "1",
      _dataDir: testDir,
    });
    expect(w.ok).toBe(true);
    const r = await getPublishSettings({ _dataDir: testDir });
    const d = r.data as Record<string, unknown>;
    expect(d.wechatConfigured).toBe(true);
    expect(d.wechatAppIdMasked).toBe("wx12…cdef");
    expect(d.openComment).toBe(true);
    expect(JSON.stringify(r)).not.toContain("supersecretvalue");
  });

  it("未绑定时 wechatConfigured=false;open_comment 拒绝非法值", async () => {
    const r = await getPublishSettings({ _dataDir: testDir });
    const d = r.data as Record<string, unknown>;
    expect(d.wechatConfigured).toBe(false);
    const bad = await setPublishSettings({ open_comment: "maybe", _dataDir: testDir });
    expect(bad.ok).toBe(false);
  });
});
