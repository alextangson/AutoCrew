import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testEngineRoute } from "./settings-probe.js";
// 翻译器 P2 起收进 engine/failure-text.ts（全产品唯一一个），探针行为一个字不变
import { humanizeEngineError as humanizeProbeError } from "../engine/failure-text.js";
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

/** v1 形状（读取时自动迁移）：主端点 + 写稿专线 + 一个自定义端点 */
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

/** 迁移后主端点那条 provider 的 id（顶层端点固定叫 main） */
const MAIN = "main";

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

  it("缺 provider_id 或 model 就拒，不发任何请求", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 1 });
    expect((await testEngineRoute({ _dataDir: testDir }, { probe })).ok).toBe(false);
    expect((await testEngineRoute({ _dataDir: testDir, provider_id: MAIN }, { probe })).ok).toBe(false);
    expect((await testEngineRoute({ _dataDir: testDir, model: "main-fast" }, { probe })).ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("没配 API Key 时说人话，而不是抛命令行口径", async () => {
    const { probe, seen } = fakeProbe({ ok: true, ms: 1 });
    const res = await testEngineRoute({ _dataDir: testDir, provider_id: MAIN, model: "x" }, { probe });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("API Key");
    expect(seen).toHaveLength(0); // 没 key 就不该真发出去
  });

  it("不存在的端点明确报错，不静默落到默认档", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 1 });
    const res = await testEngineRoute({ _dataDir: testDir, provider_id: "不存在的端点", model: "x" }, { probe });
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("settings:test_route — 测的是哪一份配置", () => {
  it("主端点的两档都能测", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 12 });
    await testEngineRoute({ _dataDir: testDir, provider_id: MAIN, model: "main-fast" }, { probe });
    await testEngineRoute({ _dataDir: testDir, provider_id: MAIN, model: "main-strong" }, { probe });
    expect(seen.map((s) => s.model)).toEqual(["main-fast", "main-strong"]);
    expect(seen.every((s) => s.baseUrl === "https://main.example.com")).toBe(true);
  });

  it("岗位专线所在的端点用它自己的地址与 key——审稿也能测（白名单没了）", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 30 });
    await testEngineRoute({ _dataDir: testDir, provider_id: "writer-example-com", model: "writer-model" }, { probe });
    expect(seen[0]).toMatchObject({ baseUrl: "https://writer.example.com", model: "writer-model", apiKey: "sk-main-key-1234" });
  });

  it("自定义端点用它自己的 key 与地址", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 8 });
    await testEngineRoute({ _dataDir: testDir, provider_id: "local", model: "qwen3" }, { probe });
    expect(seen[0]).toMatchObject({ baseUrl: "http://127.0.0.1:11434", apiKey: "sk-local", model: "qwen3" });
  });

  it("payload 里的裸 base_url/api_key 一概不认——只认已保存的配置", async () => {
    await writeEngine();
    const { probe, seen } = fakeProbe({ ok: true, ms: 5 });
    await testEngineRoute(
      { _dataDir: testDir, provider_id: MAIN, model: "main-fast", base_url: "https://attacker.example.com", api_key: "sk-attacker" },
      { probe },
    );
    expect(seen[0]?.baseUrl).toBe("https://main.example.com");
    expect(seen[0]?.apiKey).toBe("sk-main-key-1234");
  });
});

describe("settings:test_route — 结果", () => {
  it("成功只回耗时与这次用的模型名——上游实际拿什么答的，这条链路看不见", async () => {
    await writeEngine();
    const { probe } = fakeProbe({ ok: true, ms: 321 });
    const res = await testEngineRoute({ _dataDir: testDir, provider_id: MAIN, model: "main-fast" }, { probe });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ms: 321, model: "main-fast", providerId: MAIN });
  });

  it("失败原样透出上游说法，只剥掉本地路径", async () => {
    await writeEngine();
    const { probe } = fakeProbe({ ok: false, ms: 90, error: "401 invalid api key\n    at /Users/x/y.ts:3" });
    const res = await testEngineRoute({ _dataDir: testDir, provider_id: MAIN, model: "main-fast" }, { probe });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("拒绝了 Key（401）");
    expect(String(res.error)).toContain("端点 main");
    expect(String(res.error)).not.toContain("/Users/x");
  });

  it("上游的 JSON 错误信封在到达界面前就拆开", async () => {
    await writeEngine();
    const { probe } = fakeProbe({ ok: false, ms: 90, error: '401 {"error":{"message":"invalid x-api-key"}}' });
    const res = await testEngineRoute({ _dataDir: testDir, provider_id: MAIN, model: "main-fast" }, { probe });
    expect(String(res.error)).toContain("拒绝了 Key（401）");
    expect(String(res.error)).not.toContain("{");
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
