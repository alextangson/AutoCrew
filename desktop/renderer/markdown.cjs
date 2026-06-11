/**
 * Markdown 安全子集 — 解析（纯函数，node 可测）与 DOM 渲染分离。
 * 支持：# ## ### 标题、- 无序表、1. 有序表、``` 代码块、**粗**、*斜*、`行内码`。
 * 不支持链接/图片/HTML（一律按纯文本输出）——XSS 纪律：DOM 只产文本节点+白名单元素。
 */

function parseInline(text) {
  const spans = [];
  let buf = "";
  let i = 0;
  const flush = () => { if (buf) { spans.push({ style: "plain", text: buf }); buf = ""; } };
  while (i < text.length) {
    // *** 不支持组合粗斜：三星前瞻让其整体走纯文本回退（LLM 常输出 ***强调***）
    if (text.startsWith("***", i)) {
      let j = i;
      while (j < text.length && text[j] === "*") j++;
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    if (text.startsWith("**", i) && text[i + 2] !== "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) { flush(); spans.push({ style: "bold", text: text.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1) { flush(); spans.push({ style: "italic", text: text.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) { flush(); spans.push({ style: "code", text: text.slice(i + 1, end) }); i = end + 1; continue; }
    }
    buf += text[i];
    i++;
  }
  flush();
  return spans;
}

function parseMarkdown(text) {
  const blocks = [];
  const lines = String(text ?? "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }

    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
      i++; // 跳过闭合 ```（无闭合则吃到结尾）
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, spans: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^[-*]\s+/, "")));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\d+\.\s+/, "")));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // 段落：连续非空、非结构行合并
    const para = [line];
    i++;
    while (
      i < lines.length && lines[i].trim() !== "" &&
      !lines[i].startsWith("```") && !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i])
    ) { para.push(lines[i]); i++; }
    blocks.push({ type: "paragraph", spans: parseInline(para.join("\n")) });
  }
  return blocks;
}

/** AST → DOM。依赖 dom.js 的 h()（浏览器环境）。 */
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const spanEl = (s) => {
    if (s.style === "bold") return h("strong", {}, s.text);
    if (s.style === "italic") return h("em", {}, s.text);
    if (s.style === "code") return h("code", { class: "md-code" }, s.text);
    return document.createTextNode(s.text);
  };
  const fillSpans = (el, spans) => { for (const s of spans) el.appendChild(spanEl(s)); return el; };
  for (const b of parseMarkdown(text)) {
    if (b.type === "heading") frag.appendChild(fillSpans(h("div", { class: "md-h md-h" + b.level }), b.spans));
    else if (b.type === "code") { const pre = h("pre", { class: "md-pre" }); pre.textContent = b.text; frag.appendChild(pre); }
    else if (b.type === "ul" || b.type === "ol") {
      const list = h(b.type, { class: "md-list" });
      for (const item of b.items) list.appendChild(fillSpans(h("li", {}), item));
      frag.appendChild(list);
    } else frag.appendChild(fillSpans(h("p", { class: "md-p" }), b.spans));
  }
  return frag;
}

// node 测试环境导出（浏览器无 module，走全局）
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseMarkdown, parseInline };
}
