// @vitest-environment happy-dom
/** 1b 验收 UI：「下一步」说了的不再重复（原因句、「已有原片…」、「…自动挂上，不对就点…」）；屏幕上不出现 A-roll；看板卡短徽章 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, length: 0 } });
vi.mock("./board-api", () => ({
  loadCard: async () => ({ ok: true, data: { ok: true, id: "content-1-a", title: "新稿", status: "draft_ready", active: true, column: "写稿中", stage: null, reason: "已有原片，等你认稿", missing: [], badges: ["已有原片，等你认稿", "从收件箱自动挂上，不对就点「不是」"], alerts: [], candidates: [], published: [], pending_receipts: [], round: 1, can_reopen: false,
    arolls: [{ fact_id: "f1", sha256: "s", path: "02-aroll/新稿-原片.mov", name: "IMG_1.mov", origin: "收件箱自动挂上", auto_attached: true, source_path: "/i/IMG_1.mov", undo_blocked: null }] } }),
  decide: async () => ({ ok: true, data: {} }), chooseFile: async () => ({ ok: false, error: "x" }), reopenScript: async () => ({ ok: true, data: {} }),
  revealFact: async () => ({ ok: true, data: {} }), openStoryboard: async () => ({ ok: true, data: {} }),
}));
vi.mock("../ui", () => ({ toast: () => {}, confirmDialog: async () => true, openDialog: async () => null }));

describe("卡片面板", () => {
  it("「下一步」已经说清的，下面不再重复旧说法；屏幕上没有 A-roll、没有「不是这条」", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { CardPanel } = await import("./CardPanel");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(createElement(CardPanel as never, { contentId: "content-1-a", onClose: () => {}, reload: async () => {}, openEditor: () => {} })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(el.textContent).toContain("已经有原片了，点了就进剪辑中");
    expect(el.textContent).not.toContain("已有原片，等你认稿");
    expect(el.textContent).not.toContain("不对就点");
    expect(el.textContent).not.toContain("A-roll");
    expect(el.textContent).not.toContain("不是这条");
    expect(el.textContent).toContain("收件箱自动挂上");
    await act(async () => { root.unmount(); });
  });
});

describe("看板卡片", () => {
  it("自动挂上的原片 →「原片已自动挂上」短徽章（和疑似原片提示并存）", async () => {
    const { cardArollBadges } = await import("./board-columns");
    expect(cardArollBadges({ column: "写稿中", badges: ["从收件箱自动挂上，不对就点「不是」"], candidates: [{ kind: "aroll", state: "candidate" }] })).toEqual(["原片已自动挂上", "发现 1 个疑似原片"]);
    expect(cardArollBadges({ column: "剪辑中", badges: ["核对后自动挂上，不对就点「不是」"], candidates: [] })).toEqual(["原片已自动挂上"]);
    expect(cardArollBadges({ column: "写稿中", badges: [], candidates: [] })).toEqual([]);
  });
});
