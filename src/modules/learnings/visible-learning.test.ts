import { describe, it, expect } from "vitest";
import { generateEditFeedback } from "../learnings/visible-learning.js";

describe("generateEditFeedback", () => {
  it("detects remove_progression_words and generates feedback", () => {
    const feedback = generateEditFeedback(
      "首先我们来看。其次分析。最后总结。",
      "我们来看，分析，总结。",
    );
    expect(feedback.hasPatterns).toBe(true);
    expect(feedback.message).toContain("记住了");
    expect(feedback.patterns).toContain("remove_progression_words");
  });

  it("detects shorten_content", () => {
    const long = "这是一个非常非常非常长的句子，包含了很多很多很多的内容，需要被大幅度缩短。这里还有更多内容。还有更多。";
    const short = "短。";
    const feedback = generateEditFeedback(long, short);
    expect(feedback.hasPatterns).toBe(true);
    expect(feedback.patterns).toContain("shorten_content");
  });

  it("returns empty feedback when no patterns detected", () => {
    const feedback = generateEditFeedback("你好世界", "你好世界！");
    expect(feedback.hasPatterns).toBe(false);
    expect(feedback.message).toBe("");
  });

  it("generates multi-pattern feedback", () => {
    const before = "首先值得一提的是，其次需要注意的是，最后综上所述。这是一个非常非常非常长的句子，包含了很多很多很多的内容。";
    const after = "短。";
    const feedback = generateEditFeedback(before, after);
    expect(feedback.hasPatterns).toBe(true);
    expect(feedback.patterns.length).toBeGreaterThanOrEqual(2);
  });
});
