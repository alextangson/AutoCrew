/**
 * markdown.cjs 纯解析器测试 — renderer 零构建文件经 createRequire 加载
 * （文件尾的 module.exports 守卫只在 node 环境生效，浏览器全局不受影响）。
 */
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseMarkdown } = require("../../desktop/renderer/markdown.cjs") as {
  parseMarkdown: (text: string) => Array<Record<string, unknown>>;
};

describe("parseMarkdown blocks", () => {
  it("parses headings, paragraphs, lists and code fences", () => {
    const ast = parseMarkdown("## 标题\n\n正文一段。\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n```\ncode here\n```");
    expect(ast.map((b) => b.type)).toEqual(["heading", "paragraph", "ul", "ol", "code"]);
    expect((ast[0] as { level: number }).level).toBe(2);
    expect((ast[2] as { items: unknown[] }).items).toHaveLength(2);
    expect((ast[4] as { text: string }).text).toBe("code here");
  });

  it("parses inline bold/italic/code inside paragraph", () => {
    const ast = parseMarkdown("有**粗体**和*斜体*和`代码`混排");
    const spans = (ast[0] as { spans: Array<{ style: string; text: string }> }).spans;
    expect(spans.map((s) => s.style)).toEqual(["plain", "bold", "plain", "italic", "plain", "code", "plain"]);
    expect(spans[1].text).toBe("粗体");
    expect(spans[5].text).toBe("代码");
  });

  it("treats HTML and links as plain text (XSS discipline)", () => {
    const ast = parseMarkdown('<img src=x onerror=alert(1)> [点我](http://evil)');
    const spans = (ast[0] as { spans: Array<{ style: string; text: string }> }).spans;
    const joined = spans.map((s) => s.text).join("");
    expect(joined).toContain("<img src=x onerror=alert(1)>");
    expect(joined).toContain("[点我](http://evil)");
    expect(spans.every((s) => ["plain", "bold", "italic", "code"].includes(s.style))).toBe(true);
  });

  it("unterminated bold falls back to plain text", () => {
    const ast = parseMarkdown("半个**粗体没闭合");
    const spans = (ast[0] as { spans: Array<{ text: string }> }).spans;
    expect(spans.map((s) => s.text).join("")).toBe("半个**粗体没闭合");
  });

  it("triple-asterisk falls back to plain text (not garbled bold)", () => {
    const ast = parseMarkdown("这是***强调***内容");
    const spans = (ast[0] as { spans: Array<{ style: string; text: string }> }).spans;
    expect(spans.map((s) => s.text).join("")).toBe("这是***强调***内容");
    expect(spans.every((s) => s.style === "plain")).toBe(true);
  });
});
