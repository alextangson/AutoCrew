import { describe, it, expect } from "vitest";
import { humanizeZh } from "../humanizer/zh.js";

describe("humanizeZh", () => {
  it("removes filler phrases", () => {
    const result = humanizeZh({ text: "值得一提的是，这个功能很好用。" });
    expect(result.ok).toBe(true);
    expect(result.humanizedText).not.toContain("值得一提的是");
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("replaces corporate buzzwords", () => {
    const result = humanizeZh({ text: "这个产品可以赋能用户，助力企业发展。" });
    expect(result.humanizedText).not.toContain("赋能");
    expect(result.humanizedText).not.toContain("助力");
    expect(result.humanizedText).toContain("帮");
  });

  it("replaces 闭环 with 跑通", () => {
    const result = humanizeZh({ text: "我们需要形成完整的闭环。" });
    expect(result.humanizedText).toContain("跑通");
    expect(result.humanizedText).not.toContain("闭环");
  });

  it("removes summary openers", () => {
    const result = humanizeZh({ text: "综上所述，这是一个好方案。" });
    expect(result.humanizedText).not.toContain("综上所述");
  });

  it("removes 总而言之 and 总的来说", () => {
    const r1 = humanizeZh({ text: "总而言之，效果不错。" });
    const r2 = humanizeZh({ text: "总的来说，还可以。" });
    expect(r1.humanizedText).not.toContain("总而言之");
    expect(r2.humanizedText).not.toContain("总的来说");
  });

  it("removes vague adjectives", () => {
    const result = humanizeZh({ text: "这是一个深度分析，全方位覆盖，多维度解读。" });
    expect(result.humanizedText).not.toContain("深度");
    expect(result.humanizedText).not.toContain("全方位");
    expect(result.humanizedText).not.toContain("多维度");
  });

  it("术语保护：深度学习/深度智联不被肢解（2026-07-08 dogfood 回归）", () => {
    const result = humanizeZh({ text: "深度学习模型的部署，深度智联发布了新品。" });
    expect(result.humanizedText).toContain("深度学习");
    expect(result.humanizedText).toContain("深度智联");
  });

  it("不插固定节奏句：多段落文本缺“说白了”也不得注入模板句（2026-07-08 dogfood 回归）", () => {
    const text = "第一段讲一个生意。\n\n第二段讲它为什么成立。\n\n第三段给判断。";
    const result = humanizeZh({ text });
    expect(result.humanizedText).not.toContain("拼的不是工具数量");
    expect(result.humanizedText).toBe(text);
  });

  it("不硬切长句：40+ 字长句的逗号不被改成句号（2026-07-08 dogfood 回归）", () => {
    const text = "创业者找我的时候，十有八九会说他们已经用人工智能省下了一大笔外包费用，而且只用了三天时间就把原型跑起来了。";
    const result = humanizeZh({ text });
    expect(result.humanizedText).toBe(text);
  });

  it("returns original text unchanged when no AI patterns found", () => {
    const clean = "今天天气不错，出去走走吧。";
    const result = humanizeZh({ text: clean });
    expect(result.ok).toBe(true);
    expect(result.humanizedText).toBe(clean);
    expect(result.changeCount).toBe(0);
  });

  it("returns ok:true and summary on success", () => {
    const result = humanizeZh({ text: "赋能用户，助力发展。" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("humanizer-zh");
  });

  it("handles empty string", () => {
    const result = humanizeZh({ text: "" });
    expect(result.ok).toBe(true);
    expect(result.humanizedText).toBe("");
  });

  it("handles multiple replacements in one pass", () => {
    const result = humanizeZh({
      text: "值得一提的是，我们需要赋能用户，打通渠道，形成闭环。综上所述，这是深度分析。",
    });
    expect(result.humanizedText).not.toContain("值得一提的是");
    expect(result.humanizedText).not.toContain("赋能");
    expect(result.humanizedText).not.toContain("闭环");
    expect(result.humanizedText).not.toContain("综上所述");
    expect(result.humanizedText).not.toContain("深度");
    expect(result.changes.length).toBeGreaterThanOrEqual(5);
  });
});
