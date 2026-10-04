import { describe, expect, it } from "vitest";
import { finalizeBlock, type DraftPanelData } from "./draft-final-lib";

const base = (over: Partial<DraftPanelData> = {}): DraftPanelData => ({
  status: "draft_ready", draft_hash: "h", version: 2, review_notes: [],
  checklist: { draft_hash: "h", current: true, items: [{ id: "a", status: "sourced", text: "x", evidence_ids: ["ev-d1"] }, { id: "b", status: "unsourced", text: "y", evidence_ids: [] }] },
  finalized: null, ...over,
});

describe("「定了」按钮", () => {
  it("没出处的项都保留了才能点", () => {
    expect(finalizeBlock(base(), new Set(), false)).toContain("1 处没出处");
    expect(finalizeBlock(base(), new Set(["b"]), false)).toBeNull();
  });
  it("清单过期、没清单、没保存都写原因", () => {
    expect(finalizeBlock(base({ checklist: { draft_hash: "old", current: false, items: [] } }), new Set(), false)).toContain("重新出清单");
    expect(finalizeBlock(base({ checklist: null }), new Set(), false)).toContain("还没有定稿清单");
    expect(finalizeBlock(base(), new Set(["b"]), true)).toContain("先保存");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChecklistRow, ReviewNotes } from "./DraftFinalPanel";

describe("清单一行（Codex 复审 P2）", () => {
  it("有出处的项也把要人看的模糊数字摆出来", () => {
    const html = renderToStaticMarkup(createElement(ChecklistRow, { item: { id: "a", status: "sourced", text: "大概三成的人", evidence_ids: ["ev-d1"], needs_human: ["大概三成"] }, kept: false, toggle: () => {} }));
    expect(html).toContain("大概三成");
    expect(html).toContain("要你看一眼的数字");
  });
});

describe("审稿意见（agent 用 save{review_notes} 附上）", () => {
  it("三项结论分项摆，并标出审的是哪一版", () => {
    const notes = [{ version: 1, at: "x", notes: { main_line: { verdict: "pass", reason: "清楚" }, payoff: { verdict: "fail", reason: "太虚", quotes: ["今天就试"] }, opening: { verdict: "pass", reason: "抓人" } } }];
    const html = renderToStaticMarkup(createElement(ReviewNotes, { notes, version: 2 }));
    expect(html).toContain("收获：不过");
    expect(html).toContain("审的是第 1 版");
  });
  it("调不通时附的原因原文照摆", () => {
    const html = renderToStaticMarkup(createElement(ReviewNotes, { notes: [{ version: 2, at: "x", notes: "codex 没登录" }], version: 2 }));
    expect(html).toContain("codex 没登录");
    expect(html).toContain("当前版");
  });
});

describe("审稿意见形状不对时退回原文（不崩）", () => {
  it.each([
    [{ main_line: { verdict: "pass", reason: "x" }, payoff: { verdict: "fail", reason: "y", quotes: "一句" }, opening: { verdict: "pass", reason: "z" } }],
    [{ main_line: { verdict: "pass", reason: { a: 1 } }, payoff: { verdict: "pass", reason: "y" }, opening: { verdict: "pass", reason: "z" } }],
    [{ main_line: { verdict: "pass", reason: "x" }, payoff: { verdict: "pass", reason: "y" }, opening: { verdict: "pass", reason: "z" }, advisories: [{ quote: 1 }] }],
  ])("%o", (notes) => {
    const html = renderToStaticMarkup(createElement(ReviewNotes, { notes: [{ version: 1, at: "x", notes }], version: 1 }));
    expect(html).toContain("<pre");
  });
});
