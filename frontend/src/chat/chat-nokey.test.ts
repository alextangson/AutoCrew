// @vitest-environment happy-dom
/** 右栏只走内置引擎（2026-10-02）：没配钥匙只显示一句「去设置里填」；配了就是普通对话，没有后端切换器。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let configured = false;
const calls: string[] = [];
vi.mock("../transport", () => ({
  invoke: async (ch: string) => {
    calls.push(ch);
    if (ch === "settings:get") return { ok: true, data: { configured } };
    if (ch === "conversations:list") return { ok: true, data: { conversations: [] } };
    if (ch === "chat:model_options") return { ok: true, data: { options: [] } };
    return { ok: true, data: {} };
  },
  subscribeEvents: () => () => {},
}));

let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

async function mount(nav = vi.fn()) {
  const { ChatDock } = await import("./ChatDock");
  await act(async () => root.render(createElement(ChatDock, { nav, view: { route: "board" } })));
  await tick();
  return nav;
}

describe("右栏", () => {
  it("没配钥匙：只有一句话和一个去设置的链接，别的都不出", async () => {
    configured = false;
    const nav = await mount();
    expect(el.textContent?.replace(/\s+/g, "")).toBe("聊天用你自己的模型钥匙，在设置→模型里填");
    expect(el.querySelector("textarea")).toBeNull();
    await act(async () => (el.querySelector("a") as HTMLAnchorElement).click());
    expect(nav).toHaveBeenCalledWith({ view: "settings", tab: "models" });
  });

  it("配了钥匙：普通对话，没有后端切换器，也不再问本机 agent 的状态", async () => {
    configured = true;
    await mount();
    expect(el.querySelector("textarea")).toBeTruthy();
    expect(el.textContent).not.toMatch(/本机|内置引擎|后端/);
    expect(calls.some((c) => c.startsWith("agent:"))).toBe(false);
  });
});
