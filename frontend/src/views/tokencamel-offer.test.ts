/** 触点判定纯函数（spec 2026-10-25-tokencamel-touchpoint §8-1）：E1–E4、E15–E19 逐行 + 24 小时边界。 */
import { describe, expect, it } from "vitest";
import type { EngineHealthView, HealthProvider } from "./engine-lib";
import { FALLBACK_WINDOW_MS, preselect, shouldOffer, type OfferState } from "./tokencamel-offer";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const offer = (over: Partial<OfferState> = {}): OfferState => ({
  ready: { onboarding: true, fallback: true },
  enabled: true,
  dismissed: {},
  preset: {
    name: "TokenCamel",
    baseUrl: "https://api.tokencamel.com/v1",
    host: "api.tokencamel.com",
    links: { keys: "https://k", pricing: "https://p", privacy: "https://v" },
    suggest: { strong: [], fast: [] },
  },
  ...over,
});

const provider = (id: string, host: string, live: HealthProvider["live"] = null, probe: HealthProvider["probe"] = null): HealthProvider => ({
  id, name: id, host, probe, live,
});
const fail = (at: string, kind: string, status?: number) => ({ at, ok: false, role: "main", kind, ...(status ? { status } : {}), error: "人话" });

function health(over: Partial<EngineHealthView> = {}): EngineHealthView {
  return {
    configured: true,
    providers: [provider("deepseek", "api.deepseek.com", fail(ago(10 * MIN), "connect")), provider("relay", "relay.example.com")],
    main: { provider: "deepseek", strong: "s", fast: "f" },
    fallback: null,
    assignments: { writer: null, reviewer: null, scout: null, analytics: null },
    warnings: [],
    ...over,
  };
}

const fb = (o: OfferState | null, h: EngineHealthView | null, now = NOW) => shouldOffer("fallback", { offer: o, health: h }, now);
const ob = (o: OfferState | null, configured: boolean | undefined) => shouldOffer("onboarding", { offer: o, configured }, NOW);

describe("shouldOffer · 通用闸", () => {
  it("E1：预设开关全 false → 两个触点都不出", () => {
    const off = offer({ ready: { onboarding: false, fallback: false } });
    expect(ob(off, false)).toBe(false);
    expect(fb(off, health())).toBe(false);
  });
  it("E2：总开关关 → 都不出", () => {
    expect(ob(offer({ enabled: false }), false)).toBe(false);
    expect(fb(offer({ enabled: false }), health())).toBe(false);
  });
  it("E3：点过「不用了」的那个不出，另一个不受影响", () => {
    const o = offer({ dismissed: { fallback: "2026-10-01T00:00:00Z" } });
    expect(fb(o, health())).toBe(false);
    expect(ob(o, false)).toBe(true);
  });
  it("E4：预设缺失（preset null / offer 读不出）→ 都不出", () => {
    expect(ob(offer({ preset: null }), false)).toBe(false);
    expect(fb(null, health())).toBe(false);
  });
});

describe("shouldOffer · 触点 A", () => {
  it("只在未配置时出；已配置、还不知道（undefined）都不出", () => {
    expect(ob(offer(), false)).toBe(true);
    expect(ob(offer(), true)).toBe(false);
    expect(ob(offer(), undefined)).toBe(false);
  });
});

describe("shouldOffer · 触点 B", () => {
  it("主线 10 分钟前连不上、无备用 → 出", () => {
    expect(fb(offer(), health())).toBe(true);
  });
  it("限流 / 超时 / 流中断 / 上游 502 都出；没 kind 的老记录不出", () => {
    for (const [kind, status] of [["rate_limit", 429], ["timeout", undefined], ["interrupted", undefined], ["upstream", 502]] as const) {
      const h = health({ providers: [provider("deepseek", "api.deepseek.com", fail(ago(MIN), kind, status))] });
      expect(fb(offer(), h), kind).toBe(true);
    }
    const old = health({ providers: [provider("deepseek", "api.deepseek.com", { at: ago(MIN), ok: false, role: "main", error: "x" })] });
    expect(fb(offer(), old)).toBe(false);
  });
  it("E15：主线 401 / 403 / 400 → 不出（备用救不了）", () => {
    for (const [kind, status] of [["auth", 401], ["auth", 403], ["upstream", 400], ["protocol", 400]] as const) {
      const h = health({ providers: [provider("deepseek", "api.deepseek.com", fail(ago(MIN), kind, status))] });
      expect(fb(offer(), h), `${kind} ${status}`).toBe(false);
    }
  });
  it("E16：30 小时前的失败不出；时效边界 23:59 出、24:01 不出", () => {
    const at = (ms: number) => health({ providers: [provider("deepseek", "api.deepseek.com", fail(ago(ms), "connect"))] });
    expect(fb(offer(), at(30 * 60 * MIN))).toBe(false);
    expect(fb(offer(), at(FALLBACK_WINDOW_MS - MIN))).toBe(true);
    expect(fb(offer(), at(FALLBACK_WINDOW_MS + MIN))).toBe(false);
  });
  it("最近一条是成功（探针后来通了）→ 不出", () => {
    const h = health({ providers: [provider("deepseek", "api.deepseek.com", fail(ago(10 * MIN), "connect"), { at: ago(MIN), ok: true, ms: 100 })] });
    expect(fb(offer(), h)).toBe(false);
  });
  it("E17：岗位端点（写稿专线）连不上、无备用 → 出；没被引用的端点坏了不算", () => {
    const providers = [provider("deepseek", "api.deepseek.com"), provider("relay", "relay.example.com", fail(ago(MIN), "connect"))];
    expect(fb(offer(), health({ providers }))).toBe(false);
    const assigned = health({ providers, assignments: { writer: { provider: "relay", model: "m" }, reviewer: null, scout: null, analytics: null } });
    expect(fb(offer(), assigned)).toBe(true);
  });
  it("E18：主端点或任一岗位端点已是 TokenCamel → 不出", () => {
    const providers = [provider("deepseek", "api.deepseek.com", fail(ago(MIN), "connect")), provider("tc", "api.tokencamel.com")];
    const asRole = health({ providers, assignments: { writer: null, reviewer: { provider: "tc", model: "m" }, scout: null, analytics: null } });
    expect(fb(offer(), asRole)).toBe(false);
    const asMain = health({ providers: [provider("tc", "api.tokencamel.com", fail(ago(MIN), "connect"))], main: { provider: "tc", strong: "s", fast: "f" } });
    expect(fb(offer(), asMain)).toBe(false);
  });
  it("E19 / E20：已有备用（含备用就是 TokenCamel 也挂了）→ 不出", () => {
    expect(fb(offer(), health({ fallback: { provider: "relay", strong: "s", fast: "f" } }))).toBe(false);
  });
  it("没有健康数据 → 不出", () => {
    expect(fb(offer(), null)).toBe(false);
  });
});

describe("preselect（E12）", () => {
  it("推荐模型不在实时列表里就不预选", () => {
    expect(preselect(["DeepSeek-V4-Pro"], ["claude-sonnet-5"])).toBe("");
    expect(preselect(["a", "b"], ["b", "a"])).toBe("a");
    expect(preselect([], ["a"])).toBe("");
  });
});
