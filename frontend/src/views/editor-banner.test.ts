// @vitest-environment happy-dom
/**
 * 1b 验收：待审的视频稿（写稿工作台）已经有原片 → 稿件页标题下那一行要出现，且只出现一次。
 * 渲染整个 Editor，不是单独渲染横幅（上一版只测了组件本身，漏了写稿工作台没挂它）。
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, length: 0,
} });

const CONTENT = { id: "content-1-abc", title: "两段原片的稿", body: "正文", platform: "douyin", status: "reviewing", tags: [], createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" };

vi.mock("../transport", () => ({
  invoke: vi.fn(async (channel: string) => channel === "content:get" ? { ok: true, content: CONTENT } : { ok: true, data: { entries: [], versions: [] }, transitions: [] }),
  subscribeEvents: () => () => {},
}));
vi.mock("./board-api", () => ({
  loadBoard: async () => ({ ok: true, data: { items: [], topics: [], wordsPerMinute: null, ontology: { enabled: true, report: null } } }),
  loadCard: async () => ({ ok: true, data: { ok: true, id: CONTENT.id, title: CONTENT.title, platform: "douyin", status: "reviewing", active: true, column: "写稿中", stage: null,
    missing: [], badges: ["已有原片，等你认稿"], candidates: [], arolls: [{ fact_id: "f1" }, { fact_id: "f2" }] } }),
}));

describe("稿件页（写稿工作台）的阶段行", () => {
  it("待审 + 已有原片：标题下出现一次「已经有原片了…」", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { Editor } = await import("./Editor");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(createElement(Editor, { id: CONTENT.id, back: () => {} })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const banners = el.querySelectorAll(".ed-production-banner");
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toContain("写稿中（待审） · 已经有原片了，稿子没问题就点上面「稿子没问题，进入制作」");
    await act(async () => { root.unmount(); });
  });
});
