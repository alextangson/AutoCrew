import { describe, expect, it } from "vitest";
import { appendWritingFeedback, renderWritingFeedback } from "./writing-feedback.js";

describe("本稿已采纳修改要求", () => {
  it("完整保留长反馈，按顺序追加，连续相同范围和要求才去重", () => {
    const firstInstruction = "完整保留原规划。".repeat(600) + "末尾也不能丢。";
    const first = appendWritingFeedback(undefined, firstInstruction, "whole", { at: "2026-09-22T00:00:00.000Z" });
    expect(first[0].instruction).toBe(firstInstruction);
    expect(appendWritingFeedback(first, firstInstruction, "whole")).toBe(first);
    const second = appendWritingFeedback(first, "现在写给一线店员", "whole");
    expect(second).toHaveLength(2);
    expect(renderWritingFeedback(second)).toContain(firstInstruction);
    expect(renderWritingFeedback(second)).toContain("本次修改要求 > 后采纳的修改要求 > 先采纳的修改要求 > 原写作约定");
    expect(first).toHaveLength(1); // 不污染传入历史
  });

  it("选区反馈保存原文锚点，相同指令作用于不同选区不能合并或泛化", () => {
    const first = appendWritingFeedback(undefined, "这里保留列表", "selection", { selection: "仓库盘点这段" });
    const next = appendWritingFeedback(first, "这里保留列表", "selection", { selection: "营业交接这段" });
    expect(next).toHaveLength(2);
    const rendered = renderWritingFeedback(next);
    expect(rendered).toContain("【仅当时选区】");
    expect(rendered).toContain("仓库盘点这段");
    expect(rendered).toContain("营业交接这段");
    expect(rendered).toContain("不得推广到全文或其他选区");
    expect(rendered).toContain("不是新增事实的证据");
  });
});
