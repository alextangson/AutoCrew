// @vitest-environment happy-dom
/** 右栏只走内置引擎（2026-10-02）：没配钥匙时旧对话照常能看，只有输入框换成「去设置里填钥匙」；配了就是普通对话，没有后端切换器。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let configured = false;
const calls: string[] = [];
vi.mock("../transport", () => ({
  invoke: async (ch: string) => {
    calls.push(ch);
    if (ch === "settings:get") return { ok: true, data: { configured } };
    if (ch === "conversations:list") return { ok: true, data: { conversations: [{ id: "conv-1-old", title: "上周聊过的那段", updatedAt: "2026-09-30T00:00:00Z", turns: 1 }] } };
    if (ch === "conversations:get") return { ok: true, data: { messages: [{ role: "user", content: "帮我写一条" }, { role: "assistant", content: "写好了，在编辑器里打开" }] } };
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
  it("没配钥匙：会话列表和旧对话照常能看，只有输入框换成去设置填钥匙的那句话", async () => {
    configured = false;
    const nav = await mount();
    expect(el.textContent).toContain("写好了，在编辑器里打开");
    expect(el.textContent).toContain("上周聊过的那段");
    expect(el.querySelector("textarea")).toBeNull();
    expect(el.querySelector(".chat-nokey")?.textContent?.replace(/\s+/g, "")).toBe("聊天用你自己的模型钥匙，在设置→模型里填");
    await act(async () => (el.querySelector(".chat-nokey a") as HTMLAnchorElement).click());
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
