/** 第三方中转推荐的后端（spec 2026-10-25-tokencamel-touchpoint §3.1 / §4.1 / §4.2 / §8-3）。 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listPresetModels,
  loadOfferPreset,
  readOfferView,
  setOfferPreference,
  setOfferPresetPathForTest,
} from "./settings-offer.js";
import { getEngineSettings } from "./settings-engine.js";

let dir: string;
const PRESET = {
  id: "tokencamel",
  name: "TokenCamel",
  baseUrl: "https://api.tokencamel.com/v1",
  protocol: "openai",
  links: { keys: "https://tokencamel.com/keys", pricing: "https://tokencamel.com/pricing", privacy: "https://tokencamel.com/privacy" },
  suggest: { strong: ["DeepSeek-V4-Pro"], fast: [] },
  touchpoints: { onboarding: true, fallback: true },
};

async function writePreset(body: unknown): Promise<void> {
  const file = path.join(dir, "preset.json");
  await fs.writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
  setOfferPresetPathForTest(file);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-offer-"));
  vi.stubEnv("AUTOCREW_LOCAL_DIR", path.join(dir, "machine"));
});
afterEach(async () => {
  setOfferPresetPathForTest();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("预设文件", () => {
  it("随仓库发版的那份：能读、地址是 openai 协议、两个触点默认全关（上线闸）", () => {
    const preset = loadOfferPreset();
    expect(preset?.baseUrl).toBe("https://api.tokencamel.com/v1");
    expect(preset?.protocol).toBe("openai");
    expect(preset?.touchpoints).toEqual({ onboarding: false, fallback: false });
  });

  it("E4：文件缺失或坏 = 全关，不抛", async () => {
    setOfferPresetPathForTest(path.join(dir, "nope.json"));
    expect(loadOfferPreset()).toBeNull();
    expect(await readOfferView()).toMatchObject({ ready: { onboarding: false, fallback: false }, preset: null });
    await writePreset("{ not json");
    expect(loadOfferPreset()).toBeNull();
    await writePreset({ ...PRESET, protocol: "anthropic" });
    expect(loadOfferPreset()).toBeNull();
    await writePreset({ ...PRESET, touchpoints: { onboarding: "yes" } });
    expect(loadOfferPreset()?.touchpoints).toEqual({ onboarding: false, fallback: false });
  });

  it("settings:get 带回 offer 块与 revision", async () => {
    await writePreset(PRESET);
    const r = (await getEngineSettings({ _dataDir: dir })) as { ok: boolean; data: Record<string, unknown> };
    expect(r.ok).toBe(true);
    expect(r.data.revision).toBe("");
    expect(r.data.offer).toMatchObject({ ready: { onboarding: true, fallback: true }, enabled: true, dismissed: {} });
  });
});

describe("settings:offer_set", () => {
  it("E3：某触点「不用了」只记那一个；总开关关再开 = 全部复活", async () => {
    await writePreset(PRESET);
    expect((await setOfferPreference({ dismiss: "fallback" })).ok).toBe(true);
    let view = await readOfferView();
    expect(Object.keys(view.dismissed as object)).toEqual(["fallback"]);
    await setOfferPreference({ enabled: false });
    view = await readOfferView();
    expect(view.enabled).toBe(false);
    expect(Object.keys(view.dismissed as object)).toEqual(["fallback"]);
    await setOfferPreference({ enabled: true });
    view = await readOfferView();
    expect(view).toMatchObject({ enabled: true, dismissed: {} });
  });

  it("开着时再点开不清 dismissed；非法输入拒绝", async () => {
    await setOfferPreference({ dismiss: "onboarding" });
    await setOfferPreference({ enabled: true });
    expect(Object.keys((await readOfferView()).dismissed as object)).toEqual(["onboarding"]);
    expect((await setOfferPreference({ dismiss: "home" })).ok).toBe(false);
    expect((await setOfferPreference({ enabled: "on" })).ok).toBe(false);
    expect((await setOfferPreference({})).ok).toBe(false);
  });

  it("文件存在本机目录 offers.json，坏了当默认", async () => {
    await setOfferPreference({ dismiss: "onboarding" });
    const file = path.join(dir, "machine", "offers.json");
    expect(JSON.parse(await fs.readFile(file, "utf-8")).dismissed.onboarding).toBeTruthy();
    await fs.writeFile(file, "garbage");
    expect(await readOfferView()).toMatchObject({ enabled: true, dismissed: {} });
  });
});

describe("settings:list_models（§8-3）", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(async () => writePreset(PRESET));

  it("正常：只回 id 列表，请求打的是预设地址并带 Bearer", async () => {
    const fetchImpl = vi.fn(async () => json(200, { data: [{ id: "DeepSeek-V4-Pro" }, { id: "claude-sonnet-5" }, { id: "DeepSeek-V4-Pro" }] }));
    const r = await listPresetModels({ api_key: "sk-ok" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, data: { models: ["DeepSeek-V4-Pro", "claude-sonnet-5"] } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.tokencamel.com/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ok");
  });

  it("E8：401/403 → Key 不对", async () => {
    for (const status of [401, 403]) {
      const r = await listPresetModels({ api_key: "sk-bad" }, { fetchImpl: (async () => json(status, {})) as unknown as typeof fetch });
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("Key 不对");
    }
  });

  it("E9：空列表 → 分组还没有可用模型", async () => {
    const r = await listPresetModels({ api_key: "sk" }, { fetchImpl: (async () => json(200, { data: [] })) as unknown as typeof fetch });
    expect(String(r.error)).toContain("还没有可用模型");
  });

  it("E11：超时 / 网络错 → 连不上哪里", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    const t = await listPresetModels({ api_key: "sk" }, { fetchImpl: hang, timeoutMs: 30 });
    expect(String(t.error)).toMatch(/^连不上 api\.tokencamel\.com：.*秒内没有回应/);
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(String((await listPresetModels({ api_key: "sk" }, { fetchImpl: down })).error)).toBe("连不上 api.tokencamel.com：fetch failed");
  });

  it("非预设 baseUrl / 没有预设：直接拒绝，不发请求", async () => {
    const fetchImpl = vi.fn();
    const r = await listPresetModels({ api_key: "sk", base_url: "https://evil.example.com/v1" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    setOfferPresetPathForTest(path.join(dir, "missing.json"));
    expect((await listPresetModels({ api_key: "sk" }, { fetchImpl: fetchImpl as unknown as typeof fetch })).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
