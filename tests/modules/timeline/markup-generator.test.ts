import { describe, it, expect } from "vitest";
import { buildMarkupPrompt } from "../../../src/modules/timeline/markup-generator.js";

const SAMPLE_SCRIPT = `
今天我们来聊聊如何选择适合自己的编程语言
首先我们来看看目前最流行的几种语言
Python以简洁著称适合初学者
而Rust则以安全性和性能闻名
`.trim();

describe("buildMarkupPrompt", () => {
  it("returns a string containing the script text", () => {
    const prompt = buildMarkupPrompt(SAMPLE_SCRIPT, "knowledge-explainer");
    expect(prompt).toContain(SAMPLE_SCRIPT);
  });

  it("contains available markup syntax ([card:], [broll:])", () => {
    const prompt = buildMarkupPrompt(SAMPLE_SCRIPT, "knowledge-explainer");
    expect(prompt).toContain("[card:");
    expect(prompt).toContain("[broll:");
  });

  it("contains all card template names", () => {
    const prompt = buildMarkupPrompt(SAMPLE_SCRIPT, "tutorial");
    expect(prompt).toContain("comparison-table");
    expect(prompt).toContain("key-points");
    expect(prompt).toContain("flow-chart");
    expect(prompt).toContain("data-chart");
  });

  it("knowledge-explainer includes 60% guidance", () => {
    const prompt = buildMarkupPrompt(SAMPLE_SCRIPT, "knowledge-explainer");
    expect(prompt).toContain("60%");
  });

  it("tutorial includes step guidance", () => {
    const prompt = buildMarkupPrompt(SAMPLE_SCRIPT, "tutorial");
    expect(prompt).toContain("step");
  });
});
