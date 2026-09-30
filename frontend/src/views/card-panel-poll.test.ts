// @vitest-environment happy-dom
/** Codex 审 segB6 P2：面板开着时，有正在核对的（pending_match / 挂载核对 checking）每 5 秒重读；没有了就停 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, length: 0 } });

let loads = 0;
const card = (status: string) => ({ ok: true, data: { ok: true, id: "content-1-a", title: "新稿", active: true, column: "剪辑中", stage: "剪辑中", reason: "", missing: [], badges: [], alerts: [], candidates: [], candidate_rows: [], published: [], pending_receipts: [], round: 1, can_reopen: false,
  arolls: [{ fact_id: "f1", sha256: "s", path: "02-aroll/x.mov", auto_attached: false, source_path: null, check: { status, ...(status === "suggest" ? { other_id: "content-2-b", other_title: "乙稿" } : {}) }, undo_blocked: null, reassign_blocked: null }] } });
vi.mock("./board-api", () => ({
  loadCard: async () => { loads += 1; return card(loads < 3 ? "checking" : "suggest"); },
  decide: async () => ({ ok: true, data: {} }), chooseFile: async () => ({ ok: false, error: "x" }), reopenScript: async () => ({ ok: true, data: {} }),
  revealFact: async () => ({ ok: true, data: {} }), openStoryboard: async () => ({ ok: true, data: {} }),
}));
vi.mock("../ui", () => ({ toast: () => {}, confirmDialog: async () => true, openDialog: async () => null }));

afterEach(() => { vi.useRealTimers(); });

describe("卡片面板轮询", () => {
  it("正在核对 → 每 5 秒重读，结果出来后显示并停止", async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { CardPanel } = await import("./CardPanel");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(createElement(CardPanel as never, { contentId: "content-1-a", onClose: () => {}, reload: async () => {}, openEditor: () => {} })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(loads).toBe(1);
    expect(el.textContent).toContain("正在核对内容");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(loads).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(loads).toBe(3);
    expect(el.textContent).toContain("这段原片听起来更像《乙稿》");
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(loads).toBe(3);
    await act(async () => { root.unmount(); });
  });
});
