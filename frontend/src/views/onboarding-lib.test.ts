import { describe, it, expect, vi } from "vitest";
import { applyPreset, buildEnginePayload, initialForm, runOnboardingSave, type OnboardingForm } from "./onboarding-lib";

function form(over: Partial<OnboardingForm> = {}): OnboardingForm {
  return { ...initialForm(), apiKey: "sk-test", ...over };
}

describe("buildEnginePayload", () => {
  it("DeepSeek 默认档：地址与两档模型都预填,只要一把 Key", () => {
    const r = buildEnginePayload(form());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.providers[0]).toMatchObject({ id: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-test" });
    expect(r.payload.providers[0].models).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(r.payload.main).toEqual({ provider: "deepseek", strong: "deepseek-v4-pro", fast: "deepseek-v4-flash" });
  });

  it("Claude 中转：模型按 opus/sonnet 预填,地址要自己填", () => {
    const f = applyPreset(form(), "claude-relay");
    expect(f.strong).toBe("claude-opus-4-8");
    expect(f.fast).toBe("claude-sonnet-5");
    expect(buildEnginePayload(f)).toMatchObject({ ok: false });
    const ok = buildEnginePayload({ ...f, baseUrl: "https://code.newcli.com/claude/ultra" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.payload.main.provider).toBe("relay");
  });

  it("其他 OpenAI 兼容：地址与强/快模型都必填", () => {
    const f = applyPreset(form(), "openai-compat");
    expect(buildEnginePayload({ ...f, baseUrl: "https://x.dev" })).toMatchObject({ ok: false });
    const ok = buildEnginePayload({ ...f, baseUrl: "https://x.dev", strong: "big", fast: "small" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.payload.providers[0].models).toEqual(["big", "small"]);
  });

  it("没有 Key 就当场说缺 Key,不发请求", () => {
    expect(buildEnginePayload(form({ apiKey: "   " }))).toMatchObject({ ok: false });
  });

  it("强快同一个模型只落一条清单（models 至少一个,不重复）", () => {
    const f = { ...applyPreset(form(), "openai-compat"), baseUrl: "https://x.dev", strong: "m", fast: "m" };
    const r = buildEnginePayload(f);
    expect(r.ok && r.payload.providers[0].models).toEqual(["m"]);
  });
});

describe("runOnboardingSave", () => {
  it("引擎存好 → 探针 → 搜索：三步顺序固定", async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async (channel: string) => {
      calls.push(channel);
      if (channel === "settings:test_route") return { ok: true, data: { ms: 820 } };
      return { ok: true };
    });
    const r = await runOnboardingSave(invoke, form({ searchKey: "bocha-key" }));
    expect(calls).toEqual(["settings:set", "settings:test_route", "settings:search_set"]);
    expect(r).toMatchObject({ engineSaved: true, probeMs: 820 });
    expect(r.probeError).toBeUndefined();
  });

  it("引擎保存失败 → 停在卡上,后面两步一个都不发", async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async (channel: string) => {
      calls.push(channel);
      return { ok: false, error: "base_url 不合法" };
    });
    const r = await runOnboardingSave(invoke, form({ searchKey: "bocha-key" }));
    expect(calls).toEqual(["settings:set"]);
    expect(r).toEqual({ engineSaved: false, engineError: "base_url 不合法" });
  });

  it("探针不通 → 引擎已存,搜索照存,把那句人话交给 UI（不锁门）", async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async (channel: string) => {
      calls.push(channel);
      if (channel === "settings:test_route") return { ok: false, error: "端点 deepseek（api.deepseek.com）连不上：网络不通或域名解析失败。" };
      return { ok: true };
    });
    const r = await runOnboardingSave(invoke, form({ searchKey: "bocha-key" }));
    expect(calls).toEqual(["settings:set", "settings:test_route", "settings:search_set"]);
    expect(r.engineSaved).toBe(true);
    expect(r.probeError).toContain("连不上");
    expect(r.searchError).toBeUndefined();
  });

  it("搜索 Key 存不上 → 不回滚引擎,只留一行", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "settings:search_set") return { ok: false, error: "api_key 必须是非空字符串" };
      if (channel === "settings:test_route") return { ok: true, data: { ms: 300 } };
      return { ok: true };
    });
    const r = await runOnboardingSave(invoke, form({ searchKey: "x" }));
    expect(r.engineSaved).toBe(true);
    expect(r.searchError).toBe("api_key 必须是非空字符串");
  });

  it("没填搜索 Key → 根本不碰搜索通道", async () => {
    const calls: string[] = [];
    const invoke = vi.fn(async (channel: string) => {
      calls.push(channel);
      if (channel === "settings:test_route") return { ok: true, data: { ms: 100 } };
      return { ok: true };
    });
    await runOnboardingSave(invoke, form());
    expect(calls).toEqual(["settings:set", "settings:test_route"]);
  });
});
