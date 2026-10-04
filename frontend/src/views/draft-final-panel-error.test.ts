// @vitest-environment happy-dom
/** 定稿清单读失败要看得见、能重试，不能把面板悄悄藏掉（读失败 ≠ 这篇不走 autocrew_draft）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let fail = true;
vi.mock("../transport", () => ({
  invoke: async (ch: string) => {
    if (ch !== "draft:final_get") return { ok: true, data: {} };
    if (fail) return { ok: false, error: "网络断了" };
    return { ok: true, data: { draft_hash: "h1", version: 1, status: "drafting", review_notes: [], checklist: null } };
  },
  subscribeEvents: () => () => {},
}));
vi.mock("../ui", () => ({ toast: () => {} }));

let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

describe("定稿面板读失败", () => {
  it("显示原因和重试；恢复后点重试，面板回来", async () => {
    fail = true;
    const { DraftFinalPanel } = await import("./DraftFinalPanel");
    await act(async () => root.render(createElement(DraftFinalPanel, { contentId: "content-1", refreshKey: "k", dirty: false, reload: async () => {} })));
    await tick();
    expect(el.textContent).toContain("定稿清单没读出来：网络断了");
    const retry = [...el.querySelectorAll("button")].find((b) => b.textContent === "重试");
    expect(retry).toBeTruthy();
    fail = false;
    await act(async () => { retry!.click(); });
    await tick();
    expect(el.textContent).not.toContain("没读出来");
    expect(el.querySelector('[aria-label="定稿"]')).toBeTruthy();
  });
});
