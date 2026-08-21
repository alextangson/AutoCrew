/**
 * 自定义端点的设置面读写（设计 §Phase 4）。三条红线钉在这里：
 *   1. 读回**没有 key、也没有掩码**——只有 apiKeySet 布尔。
 *   2. 写入**整份原子**：任何一条非法/重复 id 都拒绝整次提交，一个字节都不落盘。
 *   3. 字段存在性判定：未提交保留、空数组清空、有数组走 merge。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { spawn } from "node:child_process";
import { getEngineSettings, setEngineSettings } from "./settings.js";
import { openEngineConfigFile } from "./settings-providers.js";
import { buildIpcHandlers } from "./ipc.js";

let testDir: string;

const KIMI = { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn", models: ["kimi-k3"] };
const OLLAMA = { id: "ollama", name: "本地 Ollama", baseUrl: "http://localhost:11434/v1", models: ["qwen3:32b"] };

const enginePath = () => path.join(testDir, "engine.json");
const readRaw = async () => JSON.parse(await fs.readFile(enginePath(), "utf-8")) as Record<string, unknown>;
const providersOnDisk = async () => (await readRaw()).providers as Array<Record<string, unknown>> | undefined;
const providersInView = async () => {
  const res = await getEngineSettings({ _dataDir: testDir });
  return (res.data as { providers: Array<Record<string, unknown>> }).providers;
};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-providers-"));
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  await setEngineSettings({ _dataDir: testDir, api_key: "sk-primary-key-1234" });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  vi.unstubAllEnvs();
});

describe("settings:get 的 providers 视图", () => {
  it("回 {id,name,baseUrl,protocol,models,apiKeySet}——无 key 无掩码", async () => {
    await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI, apiKey: "sk-kimi-secret-9876" }] });
    const view = await providersInView();
    expect(view).toEqual([
      { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn", protocol: null, models: ["kimi-k3"], apiKeySet: true },
    ]);
    expect(JSON.stringify(await getEngineSettings({ _dataDir: testDir }))).not.toContain("kimi-secret");
    // 掩码也不给:数组整体替换时,掩码会被原样当成真值写回来
    expect(JSON.stringify(view)).not.toContain("…");
  });

  it("没有 providers 的老配置 → 空数组（不是缺字段，前端不用做形状判断）", async () => {
    expect(await providersInView()).toEqual([]);
  });
});

describe("setEngineSettings 的 providers merge", () => {
  it("新增：非空 apiKey 落盘，baseUrl 归一化尾斜杠", async () => {
    const res = await setEngineSettings({
      _dataDir: testDir,
      providers: [{ ...KIMI, baseUrl: "https://api.moonshot.cn/", apiKey: "sk-kimi" }],
    });
    expect(res.ok).toBe(true);
    expect(await providersOnDisk()).toEqual([
      { id: "kimi", name: "Kimi", baseUrl: "https://api.moonshot.cn", apiKey: "sk-kimi", models: ["kimi-k3"] },
    ]);
  });

  it("已有 id 留空 key = 保留原值；非空 = 替换", async () => {
    await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI, apiKey: "sk-old" }] });

    await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI, name: "Kimi 改名了", models: ["kimi-k3", "kimi-k3-turbo"] }] });
    let onDisk = (await providersOnDisk())!;
    expect(onDisk[0].apiKey).toBe("sk-old"); // 只改了名字与模型,key 必须留住
    expect(onDisk[0].name).toBe("Kimi 改名了");
    expect(onDisk[0].models).toEqual(["kimi-k3", "kimi-k3-turbo"]);

    await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI, apiKey: "sk-new" }] });
    onDisk = (await providersOnDisk())!;
    expect(onDisk[0].apiKey).toBe("sk-new");
  });

  it("新 id 没给 key → 拒绝整次提交（并且已有的那条不受影响）", async () => {
    await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI, apiKey: "sk-kimi" }] });
    const res = await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI }, { ...OLLAMA }] });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("必须填 API Key");
    expect((await providersOnDisk())!.map((p) => p.id)).toEqual(["kimi"]);
  });

  it("缺席 = 删除；空数组 = 清空；未提交 providers 字段 = 保留文件现值", async () => {
    await setEngineSettings({
      _dataDir: testDir,
      providers: [{ ...KIMI, apiKey: "sk-kimi" }, { ...OLLAMA, apiKey: "sk-ollama" }],
    });
    expect((await providersOnDisk())!.map((p) => p.id)).toEqual(["kimi", "ollama"]);

    // 只提交一条 = 另一条被删
    await setEngineSettings({ _dataDir: testDir, providers: [{ ...OLLAMA }] });
    expect((await providersOnDisk())!.map((p) => p.id)).toEqual(["ollama"]);

    // 改别的字段但不带 providers = 现值原样留着
    await setEngineSettings({ _dataDir: testDir, base_url: "https://relay.example.com" });
    expect((await providersOnDisk())!.map((p) => p.id)).toEqual(["ollama"]);

    // 空数组 = 显式清空
    await setEngineSettings({ _dataDir: testDir, providers: [] });
    expect(await providersOnDisk()).toEqual([]);
    expect(await providersInView()).toEqual([]);
  });

  it("非法条目一律拒绝整次写入，并说清是哪一条；文件保持原样（不部分写）", async () => {
    await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI, apiKey: "sk-kimi" }] });
    const before = await readRaw();
    const cases: Array<[unknown, string]> = [
      [[{ ...KIMI }, { ...OLLAMA, id: "Ollama", apiKey: "k" }], "id 不合法"],
      [[{ ...KIMI }, { ...OLLAMA, id: "ol:lama", apiKey: "k" }], "id 不合法"],
      [[{ ...KIMI }, { ...OLLAMA, id: "", apiKey: "k" }], "id 不合法"],
      [[{ ...KIMI }, { ...KIMI, name: "重复的" }], "重复"],
      [[{ ...KIMI, baseUrl: "ftp://x.com" }], "地址不合法"],
      [[{ ...KIMI, baseUrl: "https://u:p@x.com" }], "地址不合法"],
      [[{ ...KIMI, baseUrl: "https://x.com?k=1" }], "地址不合法"],
      [[{ ...KIMI, models: [] }], "至少要填一个模型"],
      [[{ ...KIMI, name: "  " }], "缺名称"],
      [[{ ...KIMI, protocol: "grpc" }], "protocol"],
      [[{ ...KIMI }, "不是对象"], "不是对象"],
      ["providers 不是数组", "必须是数组"],
    ];
    for (const [providers, expected] of cases) {
      const res = await setEngineSettings({ _dataDir: testDir, providers });
      expect(res.ok, `应当拒绝：${JSON.stringify(providers)}`).toBe(false);
      expect(String(res.error)).toContain(expected);
      expect(await readRaw()).toEqual(before); // 一个字节都没写
    }
  });

  it("protocol：留空 = 不落盘（引擎按 key/域名推断），显式选了才写", async () => {
    await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI, apiKey: "sk-kimi", protocol: "" }] });
    expect((await providersOnDisk())![0].protocol).toBeUndefined();
    expect((await providersInView())[0].protocol).toBeNull();

    await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI, protocol: "anthropic" }] });
    expect((await providersOnDisk())![0].protocol).toBe("anthropic");
    expect((await providersInView())[0].protocol).toBe("anthropic");
  });

  it("只提交 providers 也算有可写字段（不会被「没有可写入的字段」挡掉）", async () => {
    const res = await setEngineSettings({ _dataDir: testDir, providers: [{ ...KIMI, apiKey: "sk-kimi" }] });
    expect(res.ok).toBe(true);
    // 顶层与路由一个都没动
    const raw = await readRaw();
    expect(raw.apiKey).toBe("sk-primary-key-1234");
  });
});

describe("openEngineConfigFile（打开配置文件的逃生门）", () => {
  function mockSpawn(): { impl: typeof spawn; calls: Array<[string, string[]]> } {
    const calls: Array<[string, string[]]> = [];
    const impl = ((cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return { unref: () => {} };
    }) as unknown as typeof spawn;
    return { impl, calls };
  }

  it("darwin 用 open 打开实际路径；win32 走 cmd start；其余 xdg-open", async () => {
    for (const [platform, cmd] of [["darwin", "open"], ["win32", "cmd"], ["linux", "xdg-open"]] as const) {
      const { impl, calls } = mockSpawn();
      const res = await openEngineConfigFile({ _dataDir: testDir }, { spawnImpl: impl, platform });
      expect(res.ok).toBe(true);
      expect((res.data as { path: string; opened: boolean })).toEqual({ path: enginePath(), opened: true });
      expect(calls[0][0]).toBe(cmd);
      expect(calls[0][1][calls[0][1].length - 1]).toBe(enginePath());
    }
  });

  it("文件还不存在 → 明说没有配置文件，不假装打开了", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-noconfig-"));
    try {
      const { impl, calls } = mockSpawn();
      const res = await openEngineConfigFile({ _dataDir: empty }, { spawnImpl: impl, platform: "darwin" });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain("还没有配置文件");
      expect(calls).toHaveLength(0);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("通道已登记：settings:open_config 在 buildIpcHandlers 里有 handler 并真的转到本模块", async () => {
    const handler = buildIpcHandlers()["settings:open_config"];
    expect(typeof handler).toBe("function");
    // 指一个没有 engine.json 的目录:走到"文件不存在"的出口就证明转发到位,且不会真去开窗
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-noconfig-ch-"));
    try {
      const res = await handler({ _dataDir: empty });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain("还没有配置文件");
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("spawn 抛错 → 降级为「请手动打开」并给出真实路径，不炸", async () => {
    const boom = (() => {
      throw new Error("no open binary");
    }) as unknown as typeof spawn;
    const res = await openEngineConfigFile({ _dataDir: testDir }, { spawnImpl: boom, platform: "darwin" });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ path: enginePath(), opened: false });
  });
});
