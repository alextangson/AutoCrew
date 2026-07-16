import { describe, expect, it } from "vitest";
import { enrichBodyImagePrompt } from "./body-image-prompt.js";

describe("enrichBodyImagePrompt", () => {
  it("带「标签:」→ 解释图:把每个中文标签印进图,且限定只有这些字", () => {
    const out = enrichBodyImagePrompt("左到右的三步流程，选题进入、经过写作、产出成稿。标签:定选题、写初稿、出成稿");
    expect(out).toContain("「定选题」");
    expect(out).toContain("「写初稿」");
    expect(out).toContain("「出成稿」");
    expect(out).toContain("Show no other text besides these labels");
    // 画面主体保留,尾部标签子句从画面里剥掉
    expect(out).toContain("左到右的三步流程");
    expect(out).not.toContain("标签:");
  });

  it("解释图的标签支持顿号/斜杠/逗号混合分隔", () => {
    const out = enrichBodyImagePrompt("环形循环。标签:用户提示 / AI 执行、结果检查，下一轮");
    for (const label of ["用户提示", "AI 执行", "结果检查", "下一轮"]) {
      expect(out).toContain(`「${label}」`);
    }
  });

  it("无标签 → 氛围图:强制画面内不出现任何文字", () => {
    const out = enrichBodyImagePrompt("深夜便利店的收银台，暖黄灯光下一杯冒热气的咖啡");
    expect(out).toContain("no text");
    expect(out).toContain("深夜便利店的收银台");
    expect(out).not.toContain("callouts");
  });

  it("漏写「标签:」但画面是图表/结构 → 图解模式:渲染点名的中文字,不禁字(安全网)", () => {
    const out = enrichBodyImagePrompt("四象限图，横轴是能否被AI替代、纵轴是需求增速，右上角高亮甜蜜点区域");
    expect(out).toContain("四象限图");
    expect(out).toContain("Render the Chinese words"); // 走图解模式
    expect(out).not.toContain("no text, letters, numbers"); // 不误加禁字规则
    expect(out).toContain("Swiss editorial illustration");
  });

  it("流程/节点类画面漏写标签也进图解模式,不被当无字氛围图", () => {
    const out = enrichBodyImagePrompt("从想法到上线产品的工作流程示意图，节点部署、数据库、认证、监控留白");
    expect(out).toContain("Render the Chinese words");
    expect(out).not.toContain("no text, letters, numbers");
  });

  it("两种模式都套同一 house-style 与反 AI-slop 约束", () => {
    for (const hint of ["纸质合同被红线圈住", "机制图。标签:输入、处理、输出"]) {
      const out = enrichBodyImagePrompt(hint);
      expect(out).toContain("Swiss editorial illustration");
      expect(out).toContain("No watermarks");
      expect(out).toContain("Avoid glowing keyboards");
    }
  });

  it("已含 house-style 的成品 prompt 原样返回,不二次包裹", () => {
    const finished = enrichBodyImagePrompt("纸质合同被红线圈住");
    expect(enrichBodyImagePrompt(finished)).toBe(finished);
  });
});
