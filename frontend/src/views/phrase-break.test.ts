/**
 * phrase-break —— 断言不变量而不是具体切法：ICU 词典随版本演进，钉死某句话的
 * 完整切分等于把测试焊在词典版本上。真正要锁的是：不改内容、不劈常见词、
 * 不在禁排位与纯拉丁交界造断点。
 */
import { describe, it, expect } from "vitest";
import { phraseBreak } from "./phrase-break.js";

const ZWSP = "​";
const strip = (s: string): string => s.replaceAll(ZWSP, "");

describe("phraseBreak", () => {
  it("只加断点不改内容：剥掉零宽空格后与原文逐字相等", () => {
    const titles = [
      'CLAUDE.md 里的"禁止"，只有 4% 会被真正拦截',
      "520 次整仓库重构仅 5.4% 通过：agent 离真迁移还差多远",
      "DeepSeek 多模态突然上线：鲸鱼终于有眼睛了，视觉能力到底几分",
      "",
      "（无标题）",
    ];
    for (const t of titles) expect(strip(phraseBreak(t))).toBe(t);
  });

  it("常见双字词内部没有断点（劈开「拦截」正是这功能要治的病）", () => {
    const out = phraseBreak("只有 4% 会被真正拦截，迁移与打造都一样");
    for (const word of ["拦截", "迁移", "打造"]) expect(out).toContain(word);
  });

  it("ICU 漏收的技术词走词表合并：运维/重构/多模态不被切开", () => {
    const out = phraseBreak("运维的七条纪律：重构与多模态");
    for (const word of ["运维", "重构", "多模态"]) expect(out).toContain(word);
  });

  it("纯拉丁/数字交界不新增断点：5.4% 不会在百分号前折行", () => {
    expect(phraseBreak("仅 5.4% 通过")).toContain("5.4%");
  });

  it("行首禁排：逗号句号冒号前没有断点（逗号顶行首比劈词更难看）", () => {
    const out = phraseBreak("上线了，很好。真的：不骗你");
    expect(out).not.toMatch(new RegExp(`${ZWSP}[，。：]`, "u"));
  });

  it("行尾禁排：起始引号括号后没有断点", () => {
    const out = phraseBreak("他说“很好”（真的）");
    expect(out).not.toMatch(new RegExp(`[“（]${ZWSP}`, "u"));
  });

  it("ASCII 直引号前没有断点：「\"，」闭引号组合不许顶到行首", () => {
    const out = phraseBreak('CLAUDE.md 里的"禁止"，只有 4% 会被真正拦截');
    expect(out).not.toMatch(new RegExp(`${ZWSP}"`, "u"));
  });

  it("中英混排在词与拉丁交界处允许断行", () => {
    expect(phraseBreak("一篇看懂Agent架构")).toContain(`看懂${ZWSP}Agent`);
  });
});
