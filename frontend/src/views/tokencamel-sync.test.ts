// @vitest-environment happy-dom
/**
 * 推荐偏好的跨组件同步（Codex P2 ×2）：
 *   - 在设置页拨开关 / 点「不用了」，已挂着的顶栏红点立刻跟着收起，钉住（已点开）的卡也收；
 *   - 拨开关只重读推荐快照，不重载模型表单——没保存的端点/路由改动不能被悄悄丢掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OFFER_COPY } from "./tokencamel-offer";

const calls: string[] = [];
const state = { enabled: true, dismissed: {} as Record<string, string> };
const PRESET = {
  name: "TokenCamel", baseUrl: "https://api.tokencamel.com/v1", host: "api.tokencamel.com",
  links: { keys: "https://k.example", pricing: "https://p.example", privacy: "https://v.example" }, suggest: { strong: [], fast: [] },
};
const recent = () => new Date(Date.now() - 60_000).toISOString();
const replies: Record<string, (p: Record<string, unknown>) => unknown> = {
  "settings:get": () => ({
    ok: true,
    data: {
      configured: true, revision: "r1",
      main: { provider: "deepseek", strong: "deepseek-v4-pro", fast: "deepseek-v4-flash" }, fallback: null,
      assignments: {}, warnings: [],
      providers: [{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", protocol: null, models: ["deepseek-v4-pro"], apiKeySet: true, apiKeyMasked: "sk-…0001" }],
      offer: { ready: { onboarding: true, fallback: true }, enabled: state.enabled, dismissed: state.dismissed, preset: PRESET },
    },
  }),
  "engine:health": () => ({
    ok: true,
    data: {
      configured: true, fallback: null, assignments: {}, warnings: [],
      main: { provider: "deepseek", strong: "s", fast: "f" },
      providers: [{ id: "deepseek", name: "DeepSeek", host: "api.deepseek.com", probe: null, live: { at: recent(), ok: false, role: "main", kind: "connect", error: "连不上" } }],
    },
  }),
  "settings:offer_set": (p) => {
    if (p.enabled === false) state.enabled = false;
    if (p.enabled === true) { state.enabled = true; state.dismissed = {}; }
    if (typeof p.dismiss === "string") state.dismissed[p.dismiss] = "now";
    return { ok: true, data: {} };
  },
};
vi.mock("../transport", () => ({
  invoke: async (ch: string, p: Record<string, unknown> = {}) => { calls.push(ch); return replies[ch]?.(p) ?? { ok: true, data: {} }; },
  subscribeEvents: () => () => {},
}));

let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0; state.enabled = true; state.dismissed = {};
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const btn = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement | undefined;

describe("偏好广播", () => {
  it("别处关掉总开关 → 已挂载的红点里那张钉住的卡也收起；别处点「不用了」同理", async () => {
    const { EngineDot } = await import("./EngineBanner");
    const { setOfferPref } = await import("./TokenCamelConnect");
    await act(async () => root.render(createElement(EngineDot, { onSettings: () => {} })));
    await tick();
    await act(async () => btn(OFFER_COPY.attachFallback)!.click()); // 钉住
    await tick();
    expect(el.textContent).toContain(OFFER_COPY.fallbackNotice);
    await act(async () => { await setOfferPref({ enabled: false }); });
    await tick();
    expect(el.querySelector(".tc-offer")).toBeNull();

    await act(async () => { await setOfferPref({ enabled: true }); });
    await tick();
    expect(el.querySelector(".tc-offer")).not.toBeNull();
    await act(async () => { await setOfferPref({ dismiss: "fallback" }); });
    await tick();
    expect(el.querySelector(".tc-offer")).toBeNull();
  });
});

describe("设置页拨开关不丢未保存的改动", () => {
  it("改了主端点强模型、没保存，拨总开关后输入框里还是改过的值，settings:get 也不被为表单重拉", async () => {
    const { EngineSection } = await import("./SettingsEngine");
    await act(async () => root.render(createElement(EngineSection)));
    await tick();
    const input = [...el.querySelectorAll("input")].find((i) => (i as HTMLInputElement).value === "deepseek-v4-pro") as HTMLInputElement;
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "my-unsaved-model"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => btn("关掉")!.click());
    await tick();
    expect(el.textContent).toContain(`${OFFER_COPY.switchLabel}：关`);
    expect(input.value).toBe("my-unsaved-model");
  });
});
