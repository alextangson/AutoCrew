// @vitest-environment happy-dom
/**
 * 编辑器挂载：加载中 → 加载完。seg9 P1：加载态提前返回之后才调的 Hook 让 Hook 数变化，整页白屏。
 * 以前的测试都只渲染一次，从没走过这个切换。
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

// happy-dom 在这里没带 localStorage：给一个内存版
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, length: 0,
} });

const CONTENT = { id: "content-1-abc", title: "AI 又忘了怎么办", body: "正文", platform: "douyin", status: "approved", tags: [], createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" };

vi.mock("../transport", () => ({
  invoke: vi.fn(async (channel: string) => channel === "content:get" ? { ok: true, content: CONTENT } : { ok: true, data: { entries: [], versions: [] }, transitions: [] }),
  subscribeEvents: () => () => {},
}));
vi.mock("./board-api", () => ({
  loadBoard: async () => ({ ok: true, data: { items: [], topics: [], wordsPerMinute: null, ontology: { enabled: true, report: null } } }),
  loadCard: async () => ({ ok: false, error: "测试里不读卡片" }),
}));

describe("Editor 挂载", () => {
  it("加载中 → 加载完不白屏（Hook 顺序不变），启用后写稿页提示换成收件箱", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
    const { Editor } = await import("./Editor");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(createElement(Editor, { id: CONTENT.id, back: () => {} })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const hookErrors = errors.filter((e) => String(e).includes("hooks"));
    spy.mockRestore();
    expect(hookErrors).toEqual([]);
    expect(el.textContent).toContain("0 原片放这里");
    await act(async () => { root.unmount(); });
  });
});
