// @vitest-environment happy-dom
/**
 * seg9 P2：卡片挂原片遇到 aroll_conflict（历史归属、可改挂）→ 弹「改挂到这条？」写明现在归谁，确认后带 reassign 重试。
 */
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, length: 0 } });

const calls: Array<Record<string, unknown>> = [];
vi.mock("./board-api", () => ({
  loadCard: async () => ({ ok: true, data: { ok: true, id: "content-1-a", title: "新稿", active: true, stage: "待录制", missing: ["A-roll"], badges: [], alerts: [], candidates: [], published: [], pending_receipts: [], round: 1, can_reopen: false } }),
  decide: async (_id: string, action: string, params: Record<string, unknown>) => {
    calls.push({ action, ...params });
    return params.reassign ? { ok: true, data: {} } : { ok: false, error: "这个原片归《旧稿》", body: { ok: false, code: "aroll_conflict", owner_id: "content-2-b", owner_title: "旧稿", reassignable: true } };
  },
  chooseFile: async () => ({ ok: false, error: "x" }),
  reopenScript: async () => ({ ok: true, data: {} }),
}));
const dialogs: Array<{ title: string; body: string }> = [];
vi.mock("../ui", () => ({ toast: () => {}, confirmDialog: async (d: { title: string; body: string }) => { dialogs.push(d); return true; } }));

describe("卡片改挂", () => {
  it("冲突 → 弹窗写明归《旧稿》→ 确认后带 reassign 重试", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { CardPanel } = await import("./CardPanel");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(createElement(CardPanel as never, { contentId: "content-1-a", onClose: () => {}, reload: async () => {}, openEditor: () => {} })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const input = el.querySelector("input") as HTMLInputElement;
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(input, "/Users/x/原片.mov"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "挂到这条")!;
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(dialogs[0]?.body).toContain("《旧稿》");
    expect(calls.map((c) => c.reassign === true)).toEqual([false, true]);
    await act(async () => { root.unmount(); });
  });
});
