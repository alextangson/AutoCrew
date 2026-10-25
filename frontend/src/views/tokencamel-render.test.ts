// @vitest-environment happy-dom
/**
 * 披露渲染（spec 2026-10-25-tokencamel-touchpoint §8-2）+ 连接面板流程（E8 / E10 / E12）。
 * 每个触点与连接面板都必须带：价格链接、隐私链接、「请求会经过 TokenCamel 服务器」一句、「不用了」；
 * fallback 面板另带「会自动改由 TokenCamel 处理」那句。缺一样就红。服务端调用全部替身。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import { OFFER_COPY, type OfferPresetView } from "./tokencamel-offer";

const calls: Array<{ ch: string; p: Record<string, unknown> }> = [];
let replies: Record<string, (p: Record<string, unknown>) => Record<string, unknown>> = {};
vi.mock("../transport", () => ({
  invoke: async (ch: string, p: Record<string, unknown> = {}) => {
    calls.push({ ch, p });
    return replies[ch]?.(p) ?? { ok: true, data: {} };
  },
}));

const PRESET: OfferPresetView = {
  name: "TokenCamel",
  baseUrl: "https://api.tokencamel.com/v1",
  host: "api.tokencamel.com",
  links: { keys: "https://tokencamel.com/keys", pricing: "https://tokencamel.com/pricing", privacy: "https://tokencamel.com/privacy" },
  suggest: { strong: ["DeepSeek-V4-Pro"], fast: ["not-listed"] },
};

let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0; replies = {};
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });
const btn = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement | undefined;
const click = async (t: string) => { const b = btn(t); expect(b, t).toBeTruthy(); await act(async () => b!.click()); await tick(); };
const typeKey = async (v: string) => {
  const input = el.querySelector('input[type="password"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, v); input.dispatchEvent(new Event("input", { bubbles: true })); });
};

async function mount(touchpoint: "onboarding" | "fallback", onDismiss = () => {}) {
  const { TokenCamelOffer } = await import("./TokenCamelConnect");
  await act(async () => root.render(createElement(TokenCamelOffer, { touchpoint, preset: PRESET, revision: "r1", onDismiss, onSaved: () => {} })));
}

function expectDisclosure() {
  const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  expect(hrefs).toContain(PRESET.links.pricing);
  expect(hrefs).toContain(PRESET.links.privacy);
  expect(el.textContent).toContain(OFFER_COPY.pricing);
  expect(el.textContent).toContain(OFFER_COPY.privacy);
  expect(el.textContent).toContain("请求会经过 TokenCamel 的服务器");
  expect(btn(OFFER_COPY.dismiss)).toBeTruthy();
}

describe("披露（§8-2）", () => {
  for (const tp of ["onboarding", "fallback"] as const) {
    it(`${tp} 卡片带齐四样，文案不含禁词`, async () => {
      await mount(tp);
      expectDisclosure();
      expect(el.textContent).toContain(OFFER_COPY.name);
      expect(el.textContent).not.toMatch(/推荐|最好|官方|限时/);
      expect(el.textContent).not.toContain(OFFER_COPY.fallbackNotice);
    });
    it(`${tp} 连接面板仍带齐四样；地址只读`, async () => {
      await mount(tp);
      await click(tp === "fallback" ? OFFER_COPY.attachFallback : OFFER_COPY.attachMain);
      expectDisclosure();
      const addr = el.querySelector('input[type="text"]') as HTMLInputElement;
      expect(addr.value).toBe(PRESET.baseUrl);
      expect(addr.readOnly).toBe(true);
      expect(el.textContent?.includes(OFFER_COPY.fallbackNotice)).toBe(tp === "fallback");
    });
  }
  it("点「不用了」回调调用方", async () => {
    let n = 0;
    await mount("fallback", () => { n++; });
    await click(OFFER_COPY.dismiss);
    expect(n).toBe(1);
  });
});

describe("连接面板流程", () => {
  it("E8：Key 不对 → 面板报错，不写盘", async () => {
    replies["settings:list_models"] = () => ({ ok: false, error: "这把 Key 不对，去 TokenCamel 控制台重新复制" });
    await mount("onboarding");
    await click(OFFER_COPY.attachMain);
    await typeKey("sk-bad");
    await click(OFFER_COPY.listModels);
    expect(el.textContent).toContain("这把 Key 不对");
    expect(calls.map((c) => c.ch)).not.toContain("settings:engine_attach_preset");
  });

  it("E12 + E10：只列实时模型、不在列表里的不预选；探针失败显示原话，「再试一次」只重跑探针", async () => {
    replies["settings:list_models"] = () => ({ ok: true, data: { models: ["DeepSeek-V4-Pro", "DeepSeek-V4-Flash"] } });
    replies["settings:engine_attach_preset"] = () => ({ ok: true, data: { providerId: "tokencamel" } });
    replies["settings:test_route"] = () => ({ ok: false, error: "余额不足" });
    await mount("fallback");
    await click(OFFER_COPY.attachFallback);
    await typeKey("sk-ok");
    await click(OFFER_COPY.listModels);
    const selects = [...el.querySelectorAll("select")] as HTMLSelectElement[];
    expect(selects.map((s) => s.value)).toEqual(["DeepSeek-V4-Pro", ""]);
    expect([...selects[0].options].map((o) => o.value)).toEqual(["", "DeepSeek-V4-Pro", "DeepSeek-V4-Flash"]);
    expect(btn(OFFER_COPY.save)?.disabled).toBe(true); // 快档没选，存不了
    await act(async () => { selects[1].value = "DeepSeek-V4-Flash"; selects[1].dispatchEvent(new Event("change", { bubbles: true })); });
    await click(OFFER_COPY.save);
    const attach = calls.find((c) => c.ch === "settings:engine_attach_preset");
    expect(attach?.p).toMatchObject({ as: "fallback", api_key: "sk-ok", strong: "DeepSeek-V4-Pro", fast: "DeepSeek-V4-Flash", revision: "r1" });
    expect(el.textContent).toContain("存好了，但试了一下没通：余额不足");
    await click(OFFER_COPY.retryProbe);
    expect(calls.filter((c) => c.ch === "settings:engine_attach_preset")).toHaveLength(1);
    expect(calls.filter((c) => c.ch === "settings:test_route")).toHaveLength(2);
  });
});

describe("首次开机「高级」列表（触点 A 位置）", () => {
  const offerReply = (ready: boolean) => () => ({
    ok: true,
    data: { configured: false, revision: "", offer: { ready: { onboarding: ready, fallback: false }, enabled: true, dismissed: {}, preset: PRESET } },
  });
  async function mountAdvanced() {
    const { AdvancedEndpoint } = await import("./onboarding/AdvancedEndpoint");
    await act(async () => root.render(createElement(AdvancedEndpoint, { onSaved: () => {} })));
    await tick();
  }

  it("开关开：TokenCamel 排在最后、不预选；选中后才出卡片", async () => {
    replies["settings:get"] = offerReply(true);
    await mountAdvanced();
    const labels = [...el.querySelectorAll(".ob-kind")];
    expect(labels.at(-1)?.textContent).toBe("TokenCamel");
    expect((labels.at(-1)?.querySelector("input") as HTMLInputElement).checked).toBe(false);
    expect((labels[0].querySelector("input") as HTMLInputElement).checked).toBe(true);
    expect(el.textContent).not.toContain(OFFER_COPY.dataFlow);
    await act(async () => (labels.at(-1)?.querySelector("input") as HTMLInputElement).click());
    expectDisclosure();
  });

  it("E1：预设开关关 → 列表里没有它", async () => {
    replies["settings:get"] = offerReply(false);
    await mountAdvanced();
    expect(el.textContent).not.toContain("TokenCamel");
  });
});
