import { describe, it, expect } from "vitest";
import {
  buildResearchContext,
  generateOutline,
  getPlatformConstraints,
  formatRAWPrompt,
} from "../writing/raw-engine.js";

describe("getPlatformConstraints", () => {
  it("returns xiaohongshu constraints by default", () => {
    const c = getPlatformConstraints();
    expect(c.platform).toBe("xiaohongshu");
    expect(c.maxChars).toBe(1000);
    expect(c.emojiUsage).toBe("encouraged");
  });

  it("returns wechat_mp constraints", () => {
    const c = getPlatformConstraints("wechat_mp");
    expect(c.minChars).toBe(1500);
    expect(c.hashtagCount.max).toBe(0);
  });

  it("returns douyin constraints", () => {
    const c = getPlatformConstraints("douyin");
    expect(c.maxChars).toBe(300);
  });
});

describe("buildResearchContext", () => {
  it("extracts data points from search results", () => {
    const ctx = buildResearchContext([
      { title: "5个护肤技巧", snippet: "使用防晒霜可以减少80%的紫外线伤害，每天涂抹2次效果最佳", url: "https://example.com" },
    ]);
    expect(ctx.dataPoints.length).toBeGreaterThan(0);
    expect(ctx.sources).toContain("https://example.com");
  });

  it("detects listicle pattern from titles", () => {
    const ctx = buildResearchContext([
      { title: "10个提升效率的方法", snippet: "比如使用番茄钟", url: "https://example.com" },
    ]);
    expect(ctx.structuralPatterns).toContain("listicle");
  });

  it("detects how-to pattern", () => {
    const ctx = buildResearchContext([
      { title: "如何快速学会Python", snippet: "从基础语法开始", url: "https://example.com" },
    ]);
    expect(ctx.structuralPatterns).toContain("how-to");
  });

  it("extracts examples with trigger words", () => {
    const ctx = buildResearchContext([
      { title: "test", snippet: "比如说你可以用这个方法来提升效率。另外还有其他方式。", url: "https://example.com" },
    ]);
    expect(ctx.examples.length).toBeGreaterThan(0);
  });

  it("handles empty search results", () => {
    const ctx = buildResearchContext([]);
    expect(ctx.dataPoints).toEqual([]);
    expect(ctx.sources).toEqual([]);
  });
});

describe("generateOutline", () => {
  it("generates outline with correct section count for xiaohongshu", () => {
    const research = buildResearchContext([]);
    const outline = generateOutline("护肤技巧", research, "xiaohongshu");
    expect(outline.sections.length).toBe(4);
    expect(outline.cta.style).toBe("收藏型");
  });

  it("generates shorter outline for douyin", () => {
    const research = buildResearchContext([]);
    const outline = generateOutline("护肤技巧", research, "douyin");
    expect(outline.sections.length).toBe(3);
    expect(outline.cta.style).toBe("互动型");
  });

  it("generates longer outline for wechat_mp", () => {
    const research = buildResearchContext([]);
    const outline = generateOutline("护肤技巧", research, "wechat_mp");
    expect(outline.sections.length).toBe(6);
    expect(outline.cta.style).toBe("关注型");
  });

  it("uses suspense hook when many data points", () => {
    const research = {
      dataPoints: ["80%", "2次", "30天"],
      structuralPatterns: [],
      examples: [],
      sources: [],
    };
    const outline = generateOutline("护肤", research, "xiaohongshu");
    expect(outline.hook.type).toBe("suspense");
  });
});

describe("formatRAWPrompt", () => {
  it("includes platform constraints", () => {
    const prompt = formatRAWPrompt({
      research: { dataPoints: [], structuralPatterns: [], examples: [], sources: [] },
      outline: {
        hook: { type: "pain_point", draft: "test" },
        sections: [{ heading: "要点 1", keyPoint: "test" }],
        cta: { style: "收藏型", draft: "test" },
        estimatedLength: 500,
      },
      writingRules: [],
      styleNotes: "",
      platformConstraints: getPlatformConstraints("xiaohongshu"),
    });
    expect(prompt).toContain("xiaohongshu");
    expect(prompt).toContain("平台约束");
  });

  it("includes writing rules when present", () => {
    const prompt = formatRAWPrompt({
      research: { dataPoints: [], structuralPatterns: [], examples: [], sources: [] },
      outline: {
        hook: { type: "pain_point", draft: "test" },
        sections: [],
        cta: { style: "收藏型", draft: "test" },
        estimatedLength: 500,
      },
      writingRules: [{ rule: "禁用顺序词", source: "auto_distilled", confidence: 0.8, createdAt: "" }],
      styleNotes: "",
      platformConstraints: getPlatformConstraints(),
    });
    expect(prompt).toContain("禁用顺序词");
    expect(prompt).toContain("写作规则");
  });
});
