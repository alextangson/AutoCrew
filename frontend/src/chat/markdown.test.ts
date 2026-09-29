import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./markdown";

const html = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));

describe("回复排版（v1.2）", () => {
  it("GFM 表格、列表、标题、代码、链接都渲染", () => {
    const out = html("## 标题\n\n- 一\n- 二\n\n| 平台 | 播放 |\n|---|---|\n| 抖音 | 1万 |\n\n`code`\n\n[官网](https://s-tello.com)");
    expect(out).toContain("<h2>标题</h2>");
    expect(out).toContain("<li>一</li>");
    expect(out).toContain("<table>");
    expect(out).toContain("<td>抖音</td>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain('rel="noopener noreferrer"');
  });
  it("X5：原始 HTML / 脚本按纯文本显示，不执行", () => {
    const out = html('看这个 <script>alert(1)</script> 和 <img src=x onerror="alert(2)">');
    expect(out).not.toMatch(/<script>|<img/);
    expect(out).toContain("&lt;script&gt;");
  });
  it("X4：表格包在 chat-md 里（横向滚动由样式负责）", () => {
    expect(html("| a | b |\n|---|---|\n| 1 | 2 |")).toMatch(/^<div class="chat-md"><table>/);
  });
});
