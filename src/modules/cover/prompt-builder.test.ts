import { describe, it, expect } from "vitest";
import { buildCoverPrompts, extractCoverTitle, type PromptBuilderInput } from "../cover/prompt-builder.js";

describe("extractCoverTitle", () => {
  it("returns custom title when valid length", () => {
    expect(extractCoverTitle("很长的原始标题", "短标题")).toBe("短标题");
  });

  it("ignores custom title that is too short", () => {
    expect(extractCoverTitle("原始标题", "x")).not.toBe("x");
  });

  it("ignores custom title that is too long", () => {
    expect(extractCoverTitle("原始标题", "这个标题超过了八个字符的限制")).not.toBe("这个标题超过了八个字符的限制");
  });

  it("returns short titles as-is", () => {
    expect(extractCoverTitle("AI赚钱")).toBe("AI赚钱");
  });

  it("strips brackets and punctuation", () => {
    const result = extractCoverTitle("【重磅】发布！");
    expect(result).not.toContain("【");
    expect(result).not.toContain("】");
  });

  it("picks a segment from long titles", () => {
    const result = extractCoverTitle("如何用AI工具，三天做出一个产品，月入过万");
    expect(result.length).toBeLessThanOrEqual(8);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to first 6 chars for unsplittable long titles", () => {
    const result = extractCoverTitle("这是一个完全没有分隔符的超级长标题内容");
    expect(result.length).toBeLessThanOrEqual(8);
  });
});

describe("buildCoverPrompts", () => {
  const baseInput: PromptBuilderInput = {
    title: "AI时代如何用工具赚钱",
    body: "在这个AI快速发展的时代，普通人也可以利用各种AI工具来创造收入。本文将分享三个实战案例。",
    platform: "xhs",
    hasReferencePhotos: false,
  };

  it("returns exactly 3 prompt sets", () => {
    const prompts = buildCoverPrompts(baseInput);
    expect(prompts).toHaveLength(3);
  });

  it("labels are A, B, C", () => {
    const prompts = buildCoverPrompts(baseInput);
    expect(prompts.map((p) => p.label)).toEqual(["A", "B", "C"]);
  });

  it("does not fall back to the fixed cinematic/minimalist/bold-impact trio", () => {
    const prompts = buildCoverPrompts(baseInput);
    expect(prompts.map((p) => p.style)).not.toEqual(["cinematic", "minimalist", "bold-impact"]);
    expect(new Set(prompts.map((p) => p.creativeConcept)).size).toBe(3);
    expect(new Set(prompts.map((p) => p.visualMedium)).size).toBeGreaterThanOrEqual(2);
  });

  it("all prompts contain the title text", () => {
    const prompts = buildCoverPrompts(baseInput);
    for (const p of prompts) {
      expect(p.imagePrompt).toContain(p.titleText);
    }
  });

  it("all prompts specify 3:4 vertical orientation", () => {
    const prompts = buildCoverPrompts(baseInput);
    for (const p of prompts) {
      expect(p.imagePrompt).toContain("3:4");
      expect(p.imagePrompt).toContain("Vertical");
    }
  });

  it("all prompts include prohibition rules", () => {
    const prompts = buildCoverPrompts(baseInput);
    for (const p of prompts) {
      expect(p.imagePrompt).toContain("No watermarks");
      expect(p.imagePrompt).toContain("Avoid glowing keyboards");
    }
  });

  it("titleText is 2-8 chars", () => {
    const prompts = buildCoverPrompts(baseInput);
    for (const p of prompts) {
      expect(p.titleText.length).toBeGreaterThanOrEqual(2);
      expect(p.titleText.length).toBeLessThanOrEqual(8);
    }
  });

  it("includes reference photo instruction when hasReferencePhotos is true", () => {
    const input: PromptBuilderInput = {
      ...baseInput,
      title: "我的创业故事",
      body: "我从零开始创业的经历",
      hasReferencePhotos: true,
    };
    const prompts = buildCoverPrompts(input);
    // Person-type subject with reference photos should mention reference
    const hasRef = prompts.some((p) => p.imagePrompt.includes("reference photo"));
    expect(hasRef).toBe(true);
  });

  it("does NOT include reference photo instruction when hasReferencePhotos is false", () => {
    const prompts = buildCoverPrompts(baseInput);
    for (const p of prompts) {
      expect(p.imagePrompt).not.toContain("reference photo");
    }
  });

  it("uses reference photos conditionally without forcing every concept into a portrait", () => {
    const input: PromptBuilderInput = {
      ...baseInput,
      title: "我如何从零到一",
      body: "我的个人经历分享",
      hasReferencePhotos: true,
    };
    const prompts = buildCoverPrompts(input);
    expect(prompts.some((p) => p.imagePrompt.includes("maintain their likeness"))).toBe(true);
  });

  it("passes concrete article context into every fallback prompt", () => {
    const input: PromptBuilderInput = {
      ...baseInput,
      title: "突发！新政策发布",
      body: "今天刚刚发布的最新政策",
      hasReferencePhotos: false,
    };
    const prompts = buildCoverPrompts(input);
    expect(prompts.every((p) => p.imagePrompt.includes("新政策发布"))).toBe(true);
  });

  it("uses custom title when provided", () => {
    const input: PromptBuilderInput = {
      ...baseInput,
      customTitle: "AI赚钱",
    };
    const prompts = buildCoverPrompts(input);
    for (const p of prompts) {
      expect(p.titleText).toBe("AI赚钱");
    }
  });

  it("规则降级路径也保留个人 IP 的人物颗粒与图层约束", () => {
    const prompts = buildCoverPrompts({
      ...baseInput,
      hasReferencePhotos: true,
      styleProfile: {
        version: 1,
        name: "人物清晰的编辑封面",
        visualRules: ["人物低颗粒，文字保留印刷颗粒"],
        identityRules: ["生活照优先锁脸"],
        typographyRules: ["副标题缩略图可读"],
        layoutRules: ["主标题在人物背后，人物完全不透明"],
        avoid: ["程序员刻板印象"],
        qualityGates: ["标题不穿过脸"],
      },
    });
    expect(prompts.every((p) => p.imagePrompt.includes("人物低颗粒，文字保留印刷颗粒"))).toBe(true);
    expect(prompts.every((p) => p.imagePrompt.includes("主标题在人物背后，人物完全不透明"))).toBe(true);
  });

  it("each style has different prompt content", () => {
    const prompts = buildCoverPrompts(baseInput);
    const promptTexts = prompts.map((p) => p.imagePrompt);
    // All 3 should be different
    expect(new Set(promptTexts).size).toBe(3);
  });
});
