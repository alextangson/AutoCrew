import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateEditFeedback, prepareRuleInjection } from "../learnings/visible-learning.js";
import { addWritingRule, updateWritingRule } from "../profile/creator-profile.js";

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

describe("prepareRuleInjection", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-visible-learning-test-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("skips disabled rules", async () => {
    await addWritingRule({ rule: "启用的规则", source: "user_explicit", confidence: 1 }, testDir);
    await addWritingRule({ rule: "停用的规则", source: "user_explicit", confidence: 1 }, testDir);
    await updateWritingRule(1, { disabled: true }, testDir);

    const injection = await prepareRuleInjection(testDir);

    expect(injection.promptInjection).toContain("启用的规则");
    expect(injection.promptInjection).not.toContain("停用的规则");
    expect(injection.rules).toHaveLength(1);
  });
});
