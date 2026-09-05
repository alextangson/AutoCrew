import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEngineSettings, setEngineSettings, onEngineSettingsChanged } from "./settings-engine.js";

let testDir: string;

/** 创始人 2026-09-05 那份 v1（脱敏）：写稿/审稿/备用三处都指向同一家中转 */
const FOUNDER_V1 = {
  apiKey: "sk-deepseek-main-0001",
  baseUrl: "https://api.deepseek.com",
  strongModel: "deepseek-v4-pro",
  fastModel: "deepseek-v4-flash",
  routes: {
    writer: { baseUrl: "https://code.newcli.com/claude/ultra", model: "claude-opus-4-8", apiKey: "sk-relay-secret-9999" },
    reviewer: { baseUrl: "https://code.newcli.com/claude/ultra", model: "claude-opus-4-8", apiKey: "sk-relay-secret-9999" },
    codex: { baseUrl: "https://code.newcli.com/codex/v1", model: "gpt-5.6-sol" },
  },
  fallback: { baseUrl: "https://code.newcli.com/claude/ultra", apiKey: "sk-relay-secret-9999", strongModel: "claude-opus-4-8", fastModel: "claude-sonnet-5" },
};

const enginePath = () => path.join(testDir, "engine.json");
const backupPath = () => path.join(testDir, "engine.json.v1.bak");
const readEngine = async () => JSON.parse(await fs.readFile(enginePath(), "utf-8"));
const exists = async (p: string) => fs.access(p).then(() => true).catch(() => false);

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-engine-settings-"));
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("DEEPSEEK_BASE_URL", "");
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  vi.unstubAllEnvs();
});

describe("getEngineSettings", () => {
  it("没有文件也没有环境变量 → 未配置", async () => {
    const res = await getEngineSettings({ _dataDir: testDir });
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.configured).toBe(false);
    expect(d.source).toBe("none");
    expect(d.apiKeyMasked).toBeNull();
    expect(d.providers).toEqual([]);
  });

  it("v1 文件：configured 为真，key 只回掩码，warnings 带上同家提醒", async () => {
    await fs.writeFile(enginePath(), JSON.stringify(FOUNDER_V1));
    const res = await getEngineSettings({ _dataDir: testDir });
    const d = res.data as Record<string, unknown>;
    expect(d.configured).toBe(true);
    expect(d.source).toBe("file");
    expect(d.version).toBe(2);
    expect(String(d.apiKeyMasked)).toContain("…");
    expect(JSON.stringify(res)).not.toContain("sk-deepseek-main-0001");
    expect(JSON.stringify(res)).not.toContain("sk-relay-secret-9999");
    expect((d.warnings as string[]).some((w) => w.includes("同一家"))).toBe(true);
    // 读一次不写盘：迁移只发生在内存里
    expect(await readEngine()).toEqual(FOUNDER_V1);
  });

  it("v2 文件：老用户不会被打回首次开机", async () => {
    await fs.writeFile(
      enginePath(),
      JSON.stringify({
        version: 2,
        providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-ds-123456", models: ["ds-pro", "ds-flash"] }],
        main: { provider: "deepseek", strong: "ds-pro", fast: "ds-flash" },
      }),
    );
    const d = (await getEngineSettings({ _dataDir: testDir })).data as Record<string, unknown>;
    expect(d.configured).toBe(true);
    expect(d.strongModel).toBe("ds-pro");
    expect(d.main).toEqual({ provider: "deepseek", strong: "ds-pro", fast: "ds-flash" });
  });

  it("环境变量兜底：合成 env 端点，source=env", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-envsecretkey9876");
    const d = (await getEngineSettings({ _dataDir: testDir })).data as Record<string, unknown>;
    expect(d.configured).toBe(true);
    expect(d.source).toBe("env");
    expect(JSON.stringify(d)).not.toContain("envsecretkey");
  });

  it("每个端点回掩码与「配没配」，永不回原文", async () => {
    await fs.writeFile(enginePath(), JSON.stringify(FOUNDER_V1));
    const d = (await getEngineSettings({ _dataDir: testDir })).data as Record<string, unknown>;
    const providers = d.providers as Array<Record<string, unknown>>;
    expect(providers.length).toBe(2);
    for (const p of providers) {
      expect(p.apiKeySet).toBe(true);
      expect(String(p.apiKeyMasked)).toContain("…");
      expect(p).not.toHaveProperty("apiKey");
    }
  });
});

describe("setEngineSettings · 写入四步", () => {
  it("首次保存写出 v2 形状（一张端点表 + main 指针）", async () => {
    const res = await setEngineSettings({ _dataDir: testDir, api_key: "sk-abcdef12345678" });
    expect(res.ok).toBe(true);
    const raw = await readEngine();
    expect(raw.version).toBe(2);
    expect(raw.providers).toHaveLength(1);
    expect(raw.providers[0]).toMatchObject({ apiKey: "sk-abcdef12345678", baseUrl: "https://api.deepseek.com" });
    expect(raw.main).toMatchObject({ provider: raw.providers[0].id });
    expect(raw).not.toHaveProperty("routes");
    expect(raw).not.toHaveProperty("apiKey");
  });

  it("v1 文件第一次写成 v2 前留一份 .v1.bak，且只留第一次那份", async () => {
    await fs.writeFile(enginePath(), JSON.stringify(FOUNDER_V1));
    expect(await exists(backupPath())).toBe(false);
    await setEngineSettings({ _dataDir: testDir, strong_model: "deepseek-v4-pro-max" });
    expect(await exists(backupPath())).toBe(true);
    expect(JSON.parse(await fs.readFile(backupPath(), "utf-8"))).toEqual(FOUNDER_V1);
    expect((await readEngine()).version).toBe(2);

    // 第二次保存不再覆盖备份（原件只有一份）
    await setEngineSettings({ _dataDir: testDir, fast_model: "deepseek-v4-flash-2" });
    expect(JSON.parse(await fs.readFile(backupPath(), "utf-8"))).toEqual(FOUNDER_V1);
  });

  it("迁移后写盘：三个指针指向同一条中转 provider，密钥只存一份", async () => {
    await fs.writeFile(enginePath(), JSON.stringify(FOUNDER_V1));
    await setEngineSettings({ _dataDir: testDir, strong_model: "deepseek-v4-pro" });
    const raw = await readEngine();
    const relay = raw.assignments.writer.provider;
    expect(raw.assignments.reviewer.provider).toBe(relay);
    expect(raw.fallback.provider).toBe(relay);
    expect(raw.providers.filter((p: { apiKey: string }) => p.apiKey === "sk-relay-secret-9999")).toHaveLength(1);
    expect(raw.assignments).not.toHaveProperty("codex");
  });

  it("整图不成立就整次拒绝，文件一个字节不动", async () => {
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-abcdef12345678" });
    const before = await fs.readFile(enginePath(), "utf-8");
    const bad = await setEngineSettings({ _dataDir: testDir, assignments: { writer: { provider: "不存在的端点", model: "x" } } });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("写稿专线");
    expect(await fs.readFile(enginePath(), "utf-8")).toBe(before);
  });

  it("删掉被主端点引用的端点 → 拒绝，文件不动", async () => {
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-abcdef12345678" });
    const before = await fs.readFile(enginePath(), "utf-8");
    const res = await setEngineSettings({ _dataDir: testDir, providers: [] });
    expect(res.ok).toBe(false);
    expect(await fs.readFile(enginePath(), "utf-8")).toBe(before);
  });

  it("提交空 apiKey = 保留该 id 已存的 key（掩码不会被当真值写回去）", async () => {
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-abcdef12345678" });
    const id = (await readEngine()).providers[0].id;
    const res = await setEngineSettings({
      _dataDir: testDir,
      providers: [{ id, name: "改了个名", baseUrl: "https://api.deepseek.com", models: ["deepseek-v4-pro", "deepseek-v4-flash"], apiKey: "" }],
    });
    expect(res.ok).toBe(true);
    const raw = await readEngine();
    expect(raw.providers[0].apiKey).toBe("sk-abcdef12345678");
    expect(raw.providers[0].name).toBe("改了个名");
  });

  it("main / fallback / assignments 整体替换；fallback: null 清空", async () => {
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-abcdef12345678" });
    const mainId = (await readEngine()).providers[0].id;
    const relay = { id: "newcli", name: "newcli", baseUrl: "https://code.newcli.com/claude/ultra", apiKey: "sk-relay-000", models: ["opus", "sonnet"] };
    const kept = { id: mainId, name: "DeepSeek", baseUrl: "https://api.deepseek.com", models: ["deepseek-v4-pro", "deepseek-v4-flash"], apiKey: "" };
    const withFallback = await setEngineSettings({
      _dataDir: testDir,
      providers: [kept, relay],
      fallback: { provider: "newcli", strong: "opus", fast: "sonnet" },
      assignments: { writer: { provider: "newcli", model: "opus" } },
    });
    expect(withFallback.ok).toBe(true);
    expect((await readEngine()).fallback).toEqual({ provider: "newcli", strong: "opus", fast: "sonnet" });

    const cleared = await setEngineSettings({ _dataDir: testDir, fallback: null });
    expect(cleared.ok).toBe(true);
    const raw = await readEngine();
    expect(raw).not.toHaveProperty("fallback");
    expect(raw.assignments.writer).toEqual({ provider: "newcli", model: "opus" }); // 没提交的键保持现值
  });

  it("v1 兼容字段：岗位卡的 <role>_model 落到 assignments，审稿也有了", async () => {
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-one-key-for-all" });
    const res = await setEngineSettings({
      _dataDir: testDir,
      writer_base_url: "https://code.newcli.com/claude/ultra",
      writer_model: "claude-opus-4-8",
      reviewer_base_url: "https://code.newcli.com/claude/ultra",
      reviewer_model: "claude-opus-4-8",
      scout_model: "deepseek-v4-flash",
    });
    expect(res.ok).toBe(true);
    const raw = await readEngine();
    expect(raw.assignments.writer.model).toBe("claude-opus-4-8");
    expect(raw.assignments.reviewer.provider).toBe(raw.assignments.writer.provider);
    // scout 没给地址 → 跟着主端点那条 provider 走
    expect(raw.assignments.scout.provider).toBe(raw.main.provider);
    expect(JSON.stringify(await getEngineSettings({ _dataDir: testDir }))).not.toContain("one-key-for-all");
  });

  it("空串字段照旧拒绝；什么都没提交也拒绝", async () => {
    expect((await setEngineSettings({ _dataDir: testDir, api_key: "   " })).ok).toBe(false);
    expect((await setEngineSettings({ _dataDir: testDir })).ok).toBe(false);
  });

  it("文件权限收紧到 0600（原本 0644 也一样）", async () => {
    await fs.writeFile(enginePath(), JSON.stringify({ apiKey: "sk-old-key-123456" }), { mode: 0o644 });
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-new12345678" });
    expect((await fs.stat(enginePath())).mode & 0o777).toBe(0o600);
  });

  it("保存后不留临时文件", async () => {
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-abcdef12345678" });
    const left = (await fs.readdir(testDir)).filter((f) => f.includes(".tmp-"));
    expect(left).toEqual([]);
  });
});

describe("onEngineSettingsChanged(引擎配置保存钩子)", () => {
  it("保存成功触发;校验失败不触发;退订后不触发;监听者抛错不影响保存", async () => {
    let fired = 0;
    const off = onEngineSettingsChanged(() => {
      fired += 1;
      throw new Error("listener boom");
    });
    const ok = await setEngineSettings({ _dataDir: testDir, api_key: "sk-hook-test-1234" });
    expect(ok.ok).toBe(true);
    expect(fired).toBe(1);
    const bad = await setEngineSettings({ _dataDir: testDir, api_key: "   " });
    expect(bad.ok).toBe(false);
    expect(fired).toBe(1);
    off();
    await setEngineSettings({ _dataDir: testDir, api_key: "sk-hook-test-5678" });
    expect(fired).toBe(1);
  });
});
