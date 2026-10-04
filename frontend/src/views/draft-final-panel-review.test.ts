// @vitest-environment happy-dom
/** 验收 10-04：审稿意见附在第 4 版、定稿是第 5 版，面板仍要显示最近一次审稿并标明版本；示意 / 判断项折叠另放。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const verdict = (v: string) => ({ verdict: v, reason: `理由${v}`, quotes: [] });
const notes = (tag: string) => ({ main_line: verdict("fail"), payoff: verdict("pass"), opening: verdict("pass"), advisories: [{ text: `建议${tag}` }] });
vi.mock("../transport", () => ({
  invoke: async () => ({ ok: true, data: {
    draft_hash: "h5", version: 5, status: "draft_ready",
    review_notes: [{ version: 2, notes: notes("v2"), at: "t2" }, { version: 4, notes: notes("v4"), at: "t4" }],
    checklist: { draft_hash: "h5", current: true, items: [
      { id: "a", status: "unsourced", text: "有 52 人报名。", evidence_ids: [], reason: "没有对上证据" },
      { id: "b", status: "exempt", kind: "example", text: "打个比方，你做了三年小红书。", evidence_ids: [] },
    ] },
    finalized: null,
  } }),
  subscribeEvents: () => () => {},
}));
vi.mock("../ui", () => ({ toast: () => {} }));

let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });

describe("定稿面板：审稿记录跨版本", () => {
  it("显示第 4 版的审稿并标「审的是第 4 版，之后又改过」；示意项进折叠组、不出保留勾选", async () => {
    const { DraftFinalPanel } = await import("./DraftFinalPanel");
    await act(async () => root.render(createElement(DraftFinalPanel, { contentId: "c1", refreshKey: "k", dirty: false, reload: async () => {} })));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const text = el.textContent ?? "";
    expect(text).toContain("Codex 审稿");
    expect(text).toContain("审的是第 4 版，之后又改过");
    expect(text).toContain("建议v4");
    expect(el.querySelector("details summary")?.textContent).toContain("示意/判断，不需要出处");
    expect(el.querySelector("details")?.textContent).toContain("打个比方");
    expect(el.querySelectorAll('input[type="checkbox"]').length).toBe(1);
  });
});
