import { describe, it, expect } from "vitest";
import { humanizeZh } from "./zh.js";

describe("humanizeZh — 安全格式清理与可选建议", () => {
  it.each([
    "我们决定先做试点。\n\n我们安排同事记录。\n\n我们最后复盘结果。",
    "首先，打开设置。其次，填入 key。最后，保存。",
    "我们需要形成完整的闭环。",
    "值得一提的是，“赋能”是这份报告使用的术语。综上所述，这里需要深度分析。",
    "深度学习模型的部署，深度智联发布了新品。",
    "创业者找我的时候，十有八九会说他们已经用人工智能省下了一大笔外包费用，而且只用了三天时间就把原型跑起来了。",
    "第一段讲一个生意。\n\n第二段讲它为什么成立。\n\n第三段给判断。",
    "每一次技术浪潮，最后，赚钱的都不是淘金者。",
  ])("保留人称、顺序、术语、引文与标点：%s", (text) => {
    const result = humanizeZh({ text });
    expect(result.ok).toBe(true);
    expect(result.humanizedText).toBe(text);
    expect(result.changes).toEqual([]);
    expect(result.changeCount).toBe(0);
  });

  it("建议与实际改动分离，显式工具不会暗中应用句式或术语建议", () => {
    const text = "我们先明确目标。\n我们形成闭环。\n我们随后复盘。";
    const result = humanizeZh({ text });
    expect(result.suggestions.some((s) => s.includes("专业术语保持原意"))).toBe(true);
    expect(result.suggestions.some((s) => s.includes("不能改成“你”"))).toBe(true);
    expect(result.changeCount).toBe(0);
    expect(result.summary).toContain("均未自动应用");
    expect(result.humanizedText).not.toContain("形成跑通");
  });

  it("只清理首尾、行尾空白与换行，保留句内空格和段落节奏", () => {
    const result = humanizeZh({ text: "  甲  乙。 \r\n\r\n\r\n  缩进段落。\t\r\n" });
    expect(result.humanizedText).toBe("甲  乙。\n\n\n  缩进段落。");
    expect(result.changeCount).toBe(1);
    expect(result.changes).toEqual(["规范化首尾、行尾空白与换行"]);
    expect(humanizeZh({ text: result.humanizedText }).changeCount).toBe(0);
  });

  it("没有建议不冒充风格或事实审稿通过", () => {
    const result = humanizeZh({ text: "今天天气不错。" });
    expect(result.suggestions).toEqual([]);
    expect(result.summary).toContain("不代表已通过风格或事实审稿");
  });

  it("空文本可安全处理", () => {
    expect(humanizeZh({ text: "" })).toMatchObject({ ok: true, humanizedText: "", changeCount: 0, suggestions: [] });
  });
});
