/**
 * 引擎线路健康通道（P2 spec §4.1）。断三件事：
 * 视图不含密钥、落盘能来回、状态文件坏了当没探过（观测层不该反过来弄死产品）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { EngineConfig } from "../engine/config.js";
import {
  buildEngineHealth,
  engineHealthView,
  getEngineHealth,
  loadHealthState,
  initEngineHealth,
  probeAllProviders,
  recordLiveResult,
  recordProbeResult,
  resetEngineHealth,
  saveHealthState,
} from "./engine-health.js";
import { onEngineSettingsChanged, setEngineSettings } from "./settings-engine.js";

let dir: string;

const CONFIG: EngineConfig = {
  apiKey: "sk-main-secret",
  baseUrl: "https://api.deepseek.com",
  strongModel: "deepseek-v4-pro",
  fastModel: "deepseek-v4-flash",
  protocol: "openai",
  activeProvider: { id: "deepseek", role: "main" },
  providers: [
    { id: "deepseek", name: "DeepSeek 官方", baseUrl: "https://api.deepseek.com", apiKey: "sk-main-secret", protocol: "openai", models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
    { id: "newcli", name: "newcli 中转", baseUrl: "https://code.newcli.com/claude/ultra", apiKey: "sk-relay-secret", protocol: "anthropic", models: ["claude-opus-4-8"] },
  ],
  fallback: { baseUrl: "https://code.newcli.com/claude/ultra", apiKey: "sk-relay-secret", strongModel: "claude-opus-4-8", fastModel: "claude-opus-4-8", protocol: "anthropic" },
  assignments: { writer: { provider: "newcli", model: "claude-opus-4-8" } },
  warnings: ["备用端点和写稿专线是同一家（code.newcli.com），它挂了备用一起挂"],
};

async function writeEngineJson(): Promise<void> {
  await fs.writeFile(
    path.join(dir, "engine.json"),
    JSON.stringify({
      version: 2,
      providers: CONFIG.providers,
      main: { provider: "deepseek", strong: "deepseek-v4-pro", fast: "deepseek-v4-flash" },
    }),
    "utf-8",
  );
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-health-"));
  resetEngineHealth();
});

afterEach(async () => {
  resetEngineHealth();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("engineHealthView", () => {
  it("给出端点表 + 三个指针 + warnings，一个密钥字节都不出来", () => {
    const view = engineHealthView(CONFIG, {
      providers: { deepseek: { probe: { at: "2026-09-05T00:00:00.000Z", ok: true, ms: 1500 } } },
    });
    expect(view.configured).toBe(true);
    expect(view.providers.map((p) => p.id)).toEqual(["deepseek", "newcli"]);
    expect(view.providers[0]).toMatchObject({ host: "api.deepseek.com", probe: { ok: true, ms: 1500 } });
    // 没探过 = null，不是「坏」（spec §7 边界）
    expect(view.providers[1].probe).toBeNull();
    expect(view.providers[1].live).toBeNull();
    expect(view.main).toMatchObject({ provider: "deepseek", strong: "deepseek-v4-pro" });
    expect(view.fallback).toMatchObject({ provider: "newcli" });
    expect(view.assignments.writer).toMatchObject({ provider: "newcli", model: "claude-opus-4-8" });
    expect(view.assignments.reviewer).toBeNull();
    expect(view.warnings[0]).toContain("同一家");
    expect(JSON.stringify(view)).not.toContain("secret");
  });

  it("没配引擎：configured:false，指针全空——横幅要说「还没配」，不是「坏了」", () => {
    const view = engineHealthView(null, { providers: {} });
    expect(view).toMatchObject({ configured: false, main: null, fallback: null, providers: [] });
  });
});

describe("落盘与更新", () => {
  it("探针与真实调用各留最后一条，落盘后重启读得回来", async () => {
    await recordProbeResult("deepseek", { ok: true, ms: 1200 }, dir);
    await recordLiveResult({ providerId: "newcli", ok: false, role: "writer", jobId: "run-1", error: "fetch failed" }, dir);
    // 后到的覆盖先到的：它是「最后已知状态」，不是日志
    await recordLiveResult({ providerId: "newcli", ok: true, role: "scout", jobId: "run-2" }, dir);

    resetEngineHealth(); // 模拟重启：只剩磁盘上那份
    const state = await loadHealthState(dir);
    expect(state.providers.deepseek?.probe).toMatchObject({ ok: true, ms: 1200 });
    expect(state.providers.newcli?.live).toMatchObject({ ok: true, role: "scout", jobId: "run-2" });
    expect(state.providers.newcli?.live?.error).toBeUndefined();
  });

  it("失败的 live 记原因（脱敏后）——横幅要能说出坏在哪", async () => {
    await recordLiveResult({ providerId: "newcli", ok: false, role: "writer", error: "fetch failed" }, dir);
    const state = await loadHealthState(dir);
    expect(state.providers.newcli?.live).toMatchObject({ ok: false, role: "writer" });
    expect(state.providers.newcli?.live?.error).toContain("fetch failed");
  });

  it("健康文件缺失/损坏 = 当作没探过，不报错", async () => {
    expect(await loadHealthState(dir)).toEqual({ providers: {} });
    await fs.writeFile(path.join(dir, "engine-health.json"), "{ 这不是 JSON", "utf-8");
    expect(await loadHealthState(dir)).toEqual({ providers: {} });
    await fs.writeFile(path.join(dir, "engine-health.json"), JSON.stringify({ providers: null }), "utf-8");
    expect(await loadHealthState(dir)).toEqual({ providers: {} });
  });

  it("saveHealthState → loadHealthState 原样来回", async () => {
    const state = { providers: { x: { probe: { at: "2026-09-05T01:00:00.000Z", ok: false, ms: 20000, error: "超时" }, live: null } } };
    await saveHealthState(state, dir);
    expect(await loadHealthState(dir)).toEqual(state);
  });
});

describe("probeAllProviders / IPC", () => {
  it("每条端点用自己的 models[0] 试一次，结果进健康视图", async () => {
    await writeEngineJson();
    const seen: Array<{ baseUrl: string; model: string }> = [];
    await probeAllProviders(dir, {
      probe: async (config, model) => {
        seen.push({ baseUrl: config.baseUrl, model });
        return config.baseUrl.includes("newcli") ? { ok: false, ms: 30, error: "fetch failed" } : { ok: true, ms: 42 };
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].model).toBe("deepseek-v4-pro");

    const res = (await getEngineHealth({ _dataDir: dir })) as { ok: boolean; data: { providers: Array<{ id: string; probe: { ok: boolean } | null }> } };
    expect(res.ok).toBe(true);
    const byId = Object.fromEntries(res.data.providers.map((p) => [p.id, p]));
    expect(byId.deepseek.probe).toMatchObject({ ok: true, ms: 42 });
    expect(byId.newcli.probe?.ok).toBe(false);
  });

  it("保存设置只通知不出网：通知里点名哪几条线变了，探针由订阅方跑（spec §4.1 时机之二）", async () => {
    await writeEngineJson();
    const changes: string[][] = [];
    const off = onEngineSettingsChanged(({ changedProviderIds }) => changes.push(changedProviderIds));
    try {
      // 只改显示名/模型清单：线路没变，不该触发重探
      await setEngineSettings({
        _dataDir: dir,
        providers: [
          { id: "deepseek", name: "改个名", baseUrl: "https://api.deepseek.com", api_key: "", models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
        ],
      });
      // 换地址：这条线真的变了
      await setEngineSettings({
        _dataDir: dir,
        providers: [
          { id: "deepseek", name: "改个名", baseUrl: "https://api2.deepseek.com", api_key: "", models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
        ],
      });
    } finally {
      off();
    }
    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual([]);
    expect(changes[1]).toEqual(["deepseek"]);
  });

  it("initEngineHealth 返回退订：装上再卸下，runLoop 的回执不再往这里落", async () => {
    const off = initEngineHealth(dir);
    expect(typeof off).toBe("function");
    off();
  });

  it("没配引擎时探针是空转，不抛", async () => {
    await expect(probeAllProviders(dir, { probe: async () => ({ ok: true, ms: 1 }) })).resolves.toBeUndefined();
    expect((await buildEngineHealth(dir)).configured).toBe(false);
  });
});
