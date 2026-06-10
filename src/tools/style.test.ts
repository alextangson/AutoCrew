/**
 * style.test.ts — autocrew_style 工具单测，全 mock，零网络
 */
import { describe, it, expect } from "vitest";
import { executeStyle } from "./style.js";
import { distillStyleRules } from "../modules/learnings/style-distiller.js";
import type { StyleDistillResult } from "../modules/learnings/style-distiller.js";

// ─── Mock factories ────────────────────────────────────────────────────────────

const GOOD_DISTILL_RESULT: StyleDistillResult = {
  newRules: [
    { rule: "优先用短句", source: "auto_distilled", confidence: 0.9 },
    { rule: "避免重复用词", source: "auto_distilled", confidence: 0.8 },
  ],
  skippedDuplicates: 0,
  diffsAnalyzed: 2,
  summary: "🎯 学到 2 条新偏好：优先用短句；避免重复用词",
};

function makeDistillImpl(result: StyleDistillResult | Error) {
  return async (): Promise<StyleDistillResult> => {
    if (result instanceof Error) throw result;
    return result;
  };
}

function makeAnalyzeImpl(result: StyleDistillResult | Error) {
  return async (): Promise<StyleDistillResult> => {
    if (result instanceof Error) throw result;
    return result;
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("executeStyle", () => {
  // 1. distill happy path
  it("distill: returns ok:true with StyleDistillResult data", async () => {
    const res = await executeStyle(
      { action: "distill" },
      { distillImpl: makeDistillImpl(GOOD_DISTILL_RESULT) },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.newRules.length).toBe(2);
    expect(res.data.newRules[0].rule).toBe("优先用短句");
    expect(res.data.diffsAnalyzed).toBe(2);
    expect(res.data.summary).toContain("2 条新偏好");
  });

  // 2. absorb_samples happy path
  it("absorb_samples: returns ok:true with sample-analyzed data", async () => {
    const result: StyleDistillResult = {
      newRules: [{ rule: "开篇用问句吸引", source: "auto_distilled", confidence: 0.85 }],
      skippedDuplicates: 0,
      diffsAnalyzed: 3, // 3 samples analyzed
      summary: "🎯 学到 1 条新偏好：开篇用问句吸引",
    };

    const res = await executeStyle(
      { action: "absorb_samples", samples: ["样本1", "样本2", "样本3"] },
      { analyzeImpl: makeAnalyzeImpl(result) },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.diffsAnalyzed).toBe(3); // samples_analyzed
    expect(res.data.summary).toContain("1 条新偏好");
  });

  // 3. absorb_samples missing samples
  it("absorb_samples missing → ok:false", async () => {
    const res = await executeStyle(
      { action: "absorb_samples" },
      { analyzeImpl: makeAnalyzeImpl(GOOD_DISTILL_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/1-5/);
  });

  // 4. absorb_samples 6 entries (too many)
  it("absorb_samples 6 entries → error mentions 1-5", async () => {
    const samples = Array(6).fill("text");
    const res = await executeStyle(
      { action: "absorb_samples", samples },
      { analyzeImpl: makeAnalyzeImpl(GOOD_DISTILL_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("1-5");
    expect(res.error).toContain("6");
  });

  // 5. absorb_samples with empty-string entry
  it("absorb_samples with empty string → error mentions index", async () => {
    const res = await executeStyle(
      { action: "absorb_samples", samples: ["样本1", "", "样本3"] },
      { analyzeImpl: makeAnalyzeImpl(GOOD_DISTILL_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("samples[1]");
    expect(res.error).toContain("非空");
  });

  // 6. absorb_samples with 0 entries
  it("absorb_samples 0 entries → error mentions 1-5", async () => {
    const res = await executeStyle(
      { action: "absorb_samples", samples: [] },
      { analyzeImpl: makeAnalyzeImpl(GOOD_DISTILL_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("1-5");
  });

  // 7. unknown action
  it("unknown action → ok:false", async () => {
    const res = await executeStyle(
      { action: "foobar" },
      { distillImpl: makeDistillImpl(GOOD_DISTILL_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/未知 action/);
    expect(res.error).toContain("distill");
    expect(res.error).toContain("absorb_samples");
  });

  // 8. distill error passthrough (e.g., engine unconfigured)
  it("distill: engine unconfigured error → passthrough contains DEEPSEEK_API_KEY", async () => {
    const engineErr = new Error(
      '引擎未配置 model provider：设置环境变量 DEEPSEEK_API_KEY，或在 ~/.autocrew/engine.json 写入 {"apiKey": "..."}',
    );
    const res = await executeStyle(
      { action: "distill" },
      { distillImpl: makeDistillImpl(engineErr) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("DEEPSEEK_API_KEY");
  });

  // 9. absorb_samples error passthrough
  it("absorb_samples: impl error passthrough", async () => {
    const implErr = new Error("分析失败：样本文本过短");
    const res = await executeStyle(
      { action: "absorb_samples", samples: ["样本"] },
      { analyzeImpl: makeAnalyzeImpl(implErr) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("分析失败");
  });

  // 10. absorb_samples whitespace trimming
  it("absorb_samples: whitespace-only treated as empty", async () => {
    const res = await executeStyle(
      { action: "absorb_samples", samples: ["  \t  "] },
      { analyzeImpl: makeAnalyzeImpl(GOOD_DISTILL_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("非空");
  });

  // 11. absorb_samples with 5 valid entries (boundary)
  it("absorb_samples with 5 entries (boundary valid) → ok:true", async () => {
    const samples = ["s1", "s2", "s3", "s4", "s5"];
    const result: StyleDistillResult = {
      newRules: [],
      skippedDuplicates: 0,
      diffsAnalyzed: 5,
      summary: "🎯 暂无新风格偏好",
    };

    const res = await executeStyle(
      { action: "absorb_samples", samples },
      { analyzeImpl: makeAnalyzeImpl(result) },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.diffsAnalyzed).toBe(5);
  });

  // 12. distill with other error types (non-Error thrown)
  it("distill: non-Error thrown object → stringified", async () => {
    const badImpl: typeof distillStyleRules = async () => {
      throw "raw string error";
    };

    const res = await executeStyle(
      { action: "distill" },
      { distillImpl: badImpl },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("raw string error");
  });

  // 13. absorb_samples with non-string entry (number)
  it("absorb_samples with non-string sample [42] → error mentions index", async () => {
    const res = await executeStyle(
      { action: "absorb_samples", samples: [42] },
      { analyzeImpl: makeAnalyzeImpl(GOOD_DISTILL_RESULT) },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("samples[0]");
    expect(res.error).toContain("非空");
  });
});
