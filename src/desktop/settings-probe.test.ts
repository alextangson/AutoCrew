import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testEngineRoute, humanizeProbeError } from "./settings-probe.js";
import type { ProbeResult } from "../engine/probe.js";

let testDir: string;

/** 记下探针收到的 (baseUrl, apiKey, model, protocol)——测「测的是哪一份配置」全靠它 */
function fakeProbe(result: ProbeResult) {
  const seen: Array<{ baseUrl: string; apiKey: string; model: string; protocol?: string }> = [];
  const probe = async (config: { baseUrl: string; apiKey: string; protocol?: string }, model: string) => {
    seen.push({ baseUrl: config.baseUrl, apiKey: config.apiKey, model, ...(config.protocol ? { protocol: config.protocol } : {}) });
    return result;
  };
  return { probe: probe as never, seen };
}

const ENGINE = {
  apiKey: "sk-main-key-1234",
  baseUrl: "https://main.example.com",
  strongModel: "main-strong",
  fastModel: "main-fast",
  routes: {
    writer: { baseUrl: "https://writer.example.com", model: "writer-model", protocol: "anthropic" },
  },
  providers: [
    { id: "local", name: "本地 Ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "sk-local", models: ["qwen3"] },
  ],
};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-probe-test-"));
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("DEEPSEEK_BASE_URL", "");
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  vi.unstubAllEnvs();
});

async function writeEngine(cfg: unknown = ENGINE): Promise<void> {
  await fs.writeFile(path.join(testDir, "engine.json"), JSON.stringify(cfg));
}

describe("settings:test_route — 守卫", () => {
  it("拒绝非对象 payload", async () => {
    expect((await testEngineRoute(null as never)).ok).toBe(false);
  });

  it("缺 target 就拒，不发任何请求", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 1 });
    const res = await testEngineRoute({ _dataDir: testDir }, { probe });
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("没配 API Key 时说人话，而不是抛命令行口径", async () => {
    const { probe, seen } = fakeProbe({ ok: true, ms: 1 });
    const res = await testEngineRoute({ _dataDir: testDir, target: "fast" }, { probe });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("API Key");
    expect(seen).toHaveLength(0); // 没 key 就不该真发出去
  });

  it("不认识的 target 明确报错，不静默落到默认档", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 1 });
    const res = await testEngineRoute({ _dataDir: testDir, target: "不存在的档" }, { probe });
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("settings:test_route — 测的是哪一份配置", () => {
  it("fast/strong 走主通道的两档", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 12, model: "main-fast" });
    await testEngineRoute({ _dataDir: testDir, target: "fast" }, { probe });
    await testEngineRoute({ _dataDir: testDir, target: "strong" }, { probe });
    expect(seen.map((s) => s.model)).toEqual(["main-fast", "main-strong"]);
    expect(seen.every((s) => s.baseUrl === "https://main.example.com")).toBe(true);
  });

  it("专线用它自己的端点与模型", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 30 });
    await testEngineRoute({ _dataDir: testDir, target: "writer" }, { probe });
    expect(seen[0]).toMatchObject({ baseUrl: "https://writer.example.com", model: "writer-model" });
  });

  it("没单独配的专线落到主通道强模型——与引擎真实生效的那一档一致", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 30 });
    await testEngineRoute({ _dataDir: testDir, target: "analytics" }, { probe });
    expect(seen[0]).toMatchObject({ baseUrl: "https://main.example.com", model: "main-strong" });
  });

  it("自定义端点用它自己的 key 与地址", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 8 });
    await testEngineRoute({ _dataDir: testDir, target: "p:local:qwen3" }, { probe });
    expect(seen[0]).toMatchObject({ baseUrl: "http://127.0.0.1:11434", apiKey: "sk-local", model: "qwen3" });
  });

  it("payload 里的裸 base_url/api_key 一概不认——只认已保存的配置", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 5 });
    await testEngineRoute(
      { _dataDir: testDir, target: "fast", base_url: "https://attacker.example.com", api_key: "sk-attacker" },
      { probe },
    );
    expect(seen[0]?.baseUrl).toBe("https://main.example.com");
    expect(seen[0]?.apiKey).toBe("sk-main-key-1234");
  });
});

describe("settings:test_route — 结果", () => {
  it("成功只回耗时与这一档用的模型名——上游实际拿什么答的，这条链路看不见", async () => {
    await writeEngine();
    const { probe } = fakeProbe({ ok: true, ms: 321 });
    const res = await testEngineRoute({ _dataDir: testDir, target: "fast" }, { probe });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ms: 321, model: "main-fast" });
  });

  it("失败原样透出上游说法，只剥掉本地路径", async () => {
    await writeEngine();
    const { probe } = fakeProbe({ ok: false, ms: 90, error: "401 invalid api key\n    at /Users/x/y.ts:3" });
    const res = await testEngineRoute({ _dataDir: testDir, target: "fast" }, { probe });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("invalid api key");
    expect(String(res.error)).not.toContain("/Users/x");
  });

  it("上游的 JSON 错误信封在到达界面前就拆开", async () => {
    await writeEngine();
    const { probe } = fakeProbe({ ok: false, ms: 90, error: '401 {"error":{"message":"invalid x-api-key"}}' });
    const res = await testEngineRoute({ _dataDir: testDir, target: "fast" }, { probe });
    expect(res.error).toBe("401 · invalid x-api-key");
  });
});

describe("humanizeProbeError", () => {
  it("拆掉 JSON 信封，留状态码与那句真话", () => {
    expect(humanizeProbeError('429 {"error":{"message":"rate limited, retry in 3s"}}')).toBe("429 · rate limited, retry in 3s");
  });

  it("undici 的 fetch failed 换成能看懂的一句，原文留在括号里", () => {
    const out = humanizeProbeError('502 {"error":{"message":"fetch failed"}}');
    expect(out).toContain("连不上这个端点");
    expect(out).toContain("fetch failed");
    // 502 是观察器补的，不是上游给的——说出来只会把人引到错的方向
    expect(out.startsWith("502")).toBe(false);
  });

  it("不是信封形状的原样返回，绝不猜", () => {
    expect(humanizeProbeError("超时：20 秒内端点没有回任何内容")).toBe("超时：20 秒内端点没有回任何内容");
    expect(humanizeProbeError("400 这不是 JSON")).toBe("400 这不是 JSON");
    expect(humanizeProbeError('500 {"oops":1}')).toBe('500 · {"oops":1}');
  });
});
