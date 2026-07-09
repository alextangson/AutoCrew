/**
 * designer.test.ts — 封面设计师:submit 工具校验、自纠通道、修订模式。全 mock 零网络。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { designCoverPlan, reviseCoverDesign, type CoverDesign } from "./designer.js";
import type { runLoop } from "../../engine/loop.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-designer-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "sk-test" }), "utf-8");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const LONG_PROMPT =
  "Vertical 3:4 portrait orientation cover image. Cinematic photo-realism, dramatic lighting, " +
  'the Chinese text "封面大字" in bold sans-serif with dark gradient overlay. No watermarks.';

const goodDesign = (label: "A" | "B" | "C"): Record<string, unknown> => ({
  label,
  style: "cinematic",
  titleText: "封面大字",
  imagePrompt: LONG_PROMPT,
  layoutHint: "标题上 1/3,主体中下",
  designReason: "冲突感标题+电影光影,能停住滑动",
});

interface CapturedOpts {
  systemPrompt: string;
  userMessage: string;
}

/** mock loop:依次把 payloads 喂给指定工具,记录 execute 返回与 opts */
function mockLoop(
  toolName: string,
  payloads: Array<Record<string, unknown>>,
  execResults: string[] = [],
  captured?: CapturedOpts[],
): typeof runLoop {
  return (async (
    _config: unknown,
    opts: { systemPrompt: string; userMessage: string; tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> },
  ) => {
    captured?.push({ systemPrompt: opts.systemPrompt, userMessage: opts.userMessage });
    const tool = opts.tools.find((t) => t.name === toolName);
    if (tool) {
      for (const p of payloads) execResults.push(String(await tool.execute(p)));
    }
    return { stopReason: "tool", turns: 1, totalTokens: 321, finalText: "" };
  }) as unknown as typeof runLoop;
}

describe("designCoverPlan", () => {
  it("提交 3 方案 → 返回 A/B/C,硬规则进 system prompt,内容进 user", async () => {
    const captured: CapturedOpts[] = [];
    const { designs, tokensUsed } = await designCoverPlan(
      { title: "AI 写码的账怎么算", body: "正文……", platform: "wechat_mp", hasReferencePhotos: true },
      dir,
      { runLoopImpl: mockLoop("submit_cover_plan", [{ designs: [goodDesign("A"), goodDesign("B"), goodDesign("C")] }], [], captured) },
    );
    expect(designs.map((d) => d.label)).toEqual(["A", "B", "C"]);
    expect(tokensUsed).toBe(321);
    expect(captured[0].systemPrompt).toContain("3:4");
    expect(captured[0].systemPrompt).toContain("水印");
    expect(captured[0].systemPrompt).toContain("暗色");
    expect(captured[0].userMessage).toContain("AI 写码的账怎么算");
    expect(captured[0].userMessage).toContain("形象照");
  });

  it("横屏 16:9(V5.6.1):系统提示切横版方向词与横屏构图,用户消息带比例", async () => {
    const captured: CapturedOpts[] = [];
    await designCoverPlan(
      { title: "t", body: "b", hasReferencePhotos: false, targetAspect: "16:9" },
      dir,
      { runLoopImpl: mockLoop("submit_cover_plan", [{ designs: [goodDesign("A"), goodDesign("B"), goodDesign("C")] }], [], captured) },
    );
    expect(captured[0].systemPrompt).toContain("16:9");
    expect(captured[0].systemPrompt).toContain("横版");
    expect(captured[0].systemPrompt).not.toContain("Vertical 3:4");
    expect(captured[0].userMessage).toContain("16:9(横屏)");
  });

  it("titleText 超长/无中文 → 工具打回自纠;修正后通过", async () => {
    const bad = { designs: [{ ...goodDesign("A"), titleText: "这个标题实在太长了" }, goodDesign("B"), goodDesign("C")] };
    const execResults: string[] = [];
    const { designs } = await designCoverPlan(
      { title: "t", body: "b", hasReferencePhotos: false },
      dir,
      {
        runLoopImpl: mockLoop(
          "submit_cover_plan",
          [bad, { designs: [goodDesign("A"), goodDesign("B"), goodDesign("C")] }],
          execResults,
        ),
      },
    );
    expect(execResults[0]).toContain("Error");
    expect(execResults[0]).toContain("2-8");
    expect(execResults[1]).toContain("已收到");
    expect(designs).toHaveLength(3);
  });

  it("imagePrompt 太短 → 打回;模型不提交 → 明确报错", async () => {
    const execResults: string[] = [];
    await expect(
      designCoverPlan({ title: "t", body: "b", hasReferencePhotos: false }, dir, {
        runLoopImpl: mockLoop(
          "submit_cover_plan",
          [{ designs: [{ ...goodDesign("A"), imagePrompt: "too short" }, goodDesign("B"), goodDesign("C")] }],
          execResults,
        ),
      }),
    ).rejects.toThrow(/未调用 submit_cover_plan/);
    expect(execResults[0]).toContain("80");
  });
});

describe("reviseCoverDesign", () => {
  const previous: CoverDesign = {
    label: "B",
    style: "minimalist",
    imagePrompt: LONG_PROMPT,
    titleText: "旧的大字",
    layoutHint: "居中",
    designReason: "原方案",
  };

  it("按反馈修订 → 返回单方案,label 继承原方案,反馈进 user prompt", async () => {
    const captured: CapturedOpts[] = [];
    const revised = await reviseCoverDesign(
      { previous, feedback: "标题太温了,换更狠的;背景加霓虹", title: "t", hasReferencePhotos: false },
      dir,
      {
        runLoopImpl: mockLoop(
          "submit_cover_revision",
          [{ style: "bold-impact", titleText: "狠的大字", imagePrompt: LONG_PROMPT, layoutHint: "居中偏上", designReason: "按反馈加强冲击" }],
          [],
          captured,
        ),
      },
    );
    expect(revised.label).toBe("B");
    expect(revised.titleText).toBe("狠的大字");
    expect(captured[0].userMessage).toContain("标题太温了");
    expect(captured[0].userMessage).toContain("旧的大字");
  });

  it("模型不提交 → 报错", async () => {
    await expect(
      reviseCoverDesign({ previous, feedback: "x", title: "t", hasReferencePhotos: false }, dir, {
        runLoopImpl: mockLoop("submit_cover_revision", []),
      }),
    ).rejects.toThrow(/未调用 submit_cover_revision/);
  });
});
