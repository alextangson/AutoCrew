# Sprint 1：体验止血 + 喂料补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉创始人 dogfood 暴露的体验 bug（markdown 不渲染、链接不读、报错含糊），补全喂料侧三件套：read_url 工具、选题雷达 v1（公开热榜 → 评分选题卡）、知识库轻版（本地目录 → 生成时检索注入）。

**Architecture:** 全部沿既有四层模式：纯函数模块（src/modules/、src/utils/，vitest 全测）→ chat-router 工具包装（sanitize + 卡片 sink + 紧凑 JSON）→ IPC 通道（channels.ts 零依赖清单 + ipc.ts 注册表）→ renderer 零构建 JS（dom/cards/chat 全局作用域）。选题雷达的「定期抓取」v1 = app 启动 fire-and-forget 刷新 + 工具内 TTL 兜底（真调度器随 L2 定时拟稿上，PRD §4）；LLM 评分不嵌套调用——find_topics 把候选回给 loop 里的模型，模型的回复就是评分。

**Tech Stack:** 零新依赖。RSS 解析自写正则（两个内置源：36氪/爱范儿），markdown 自写安全子集解析器（AST 可测，DOM 构建薄层），fetch 复用 `src/utils/retry.ts` 的 `checkFetchResponse`。

**基线事实（已核对 main@e439ffa）：**
- `chat-router.ts`：`sanitize()` 剥 `_` 前缀键；`ChatToolDeps` 现有 generate/rewrite/flywheel/style/content/publish/addRule 七个注入位；工具模式 = sanitize → execute → fail()/sink.push → 紧凑 JSON。
- `src/tools/generate.ts:103-110`：`const req: ScriptRequest = { topic, platform, research }`，`dataDir` 在 109 行（req 之后——知识库接线需把 dataDir 声明提到 req 之前）。
- IPC 现 17 通道；`ipc-guard.ts`（4faefc1）在 main.ts 层剥 `_` 键，新通道自动受护，但 `scripts/smoke-desktop-load.mts` 断言 guard 接线——动 main.ts 后必须跑 smoke。
- renderer：`appendChatMessage(role, text)` 用 textContent；`renderCard` switch 6 类；`ChatCard.type` 六值联合。
- `getDataDir(customDir?)`：customDir 直返，否则 `~/.autocrew`。
- vitest 现 36 文件 490 测试全绿；lint 0 error。

---

### Task 1: markdown 安全渲染（解析器可测 + 气泡接线）

**Files:**
- Create: `desktop/renderer/markdown.js`
- Test: `src/desktop/markdown.test.ts`（经 createRequire 测纯解析器）
- Modify: `desktop/renderer/chat.js`（appendChatMessage 助手侧走 markdown）
- Modify: `desktop/renderer/index.html`（script 标签插入 markdown.js）

设计：解析与渲染分离。`parseMarkdown(text)` 纯函数产 AST（node 可测），`renderMarkdown(text)` 把 AST 转 DOM（只产文本节点 + 白名单元素，维持 XSS 纪律）。支持子集：`# ## ###` 标题、`- ` 无序表、`1. ` 有序表、``` 代码块、`**粗**`、`*斜*`、`` `行内码` ``。**不支持** 链接/图片/HTML 透传（一律按纯文本字符输出）。

- [ ] **Step 1: 写失败测试**

创建 `src/desktop/markdown.test.ts`：

```ts
/**
 * markdown.js 纯解析器测试 — renderer 零构建文件经 createRequire 加载
 * （文件尾的 module.exports 守卫只在 node 环境生效，浏览器全局不受影响）。
 */
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseMarkdown } = require("../../desktop/renderer/markdown.js") as {
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
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/desktop/markdown.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 markdown.js**

创建 `desktop/renderer/markdown.js`：

```js
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
    if (text.startsWith("**", i)) {
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/desktop/markdown.test.ts`
Expected: PASS（4 用例）。

- [ ] **Step 5: 接线 renderer**

`desktop/renderer/index.html` —— `<script src="dom.js"></script>` 之后、`cards.js` 之前插入：

```html
  <script src="markdown.js"></script>
```

`desktop/renderer/chat.js` —— `appendChatMessage` 改为助手消息走 markdown（用户消息保持纯文本）：

```js
function appendChatMessage(role, text) {
  const stream = document.getElementById("chat-stream");
  const msg = h("div", { class: "chat-msg chat-" + role });
  const bubble = h("div", { class: "chat-bubble" });
  if (role === "assistant" && typeof renderMarkdown === "function") {
    bubble.appendChild(renderMarkdown(text));
  } else {
    bubble.textContent = text;
  }
  msg.appendChild(bubble);
  stream.appendChild(msg);
  stream.scrollTop = stream.scrollHeight;
  return msg;
}
```

`desktop/renderer/style.css` 末尾追加：

```css
/* ── Markdown in chat bubbles ───────────────────────────────────────────────── */

.md-p { margin: 0; }
.md-p + .md-p, .md-list + .md-p, .md-p + .md-list { margin-top: 6px; }
.md-h { font-weight: 700; margin: 6px 0 2px; }
.md-h1 { font-size: 16px; }
.md-h2 { font-size: 15px; }
.md-h3 { font-size: 14px; }
.md-list { margin: 4px 0 4px 18px; }
.md-code {
  background: rgba(0, 0, 0, 0.06);
  border-radius: 3px;
  padding: 1px 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.md-pre {
  background: rgba(0, 0, 0, 0.06);
  border-radius: var(--radius);
  padding: 8px 10px;
  overflow-x: auto;
  font-size: 12px;
  margin: 4px 0;
}
```

- [ ] **Step 6: 验证 + Commit**

Run: `node --check desktop/renderer/markdown.js && node --check desktop/renderer/chat.js && npm run build:desktop 2>&1 | tail -2`
Expected: 全过。

```bash
git add desktop/renderer/markdown.js desktop/renderer/chat.js desktop/renderer/index.html desktop/renderer/style.css src/desktop/markdown.test.ts
git commit -m "feat: chat 气泡 markdown 安全渲染 — 自写子集解析器，AST 可测，XSS 纪律不破"
```

---

### Task 2: fetchPageText 工具函数 + read_url 工具

**Files:**
- Create: `src/utils/fetch-page.ts`
- Test: `src/utils/fetch-page.test.ts`
- Modify: `src/desktop/chat-router.ts`（新工具 read_url + deps 注入位）
- Test: `src/desktop/chat-router.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试（fetch-page）**

创建 `src/utils/fetch-page.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { fetchPageText } from "./fetch-page.js";

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

describe("fetchPageText", () => {
  it("rejects non-http(s) urls without fetching", async () => {
    await expect(fetchPageText("file:///etc/passwd")).rejects.toThrow("仅支持 http/https");
    await expect(fetchPageText("not-a-url")).rejects.toThrow("仅支持 http/https");
  });

  it("strips tags/scripts and collapses whitespace", async () => {
    const fetchImpl = (async () =>
      htmlResponse(
        "<html><head><title>测试标题</title><script>evil()</script><style>.x{}</style></head>" +
        "<body><h1>正文标题</h1><p>第一段。</p>\n\n<p>第二段。</p></body></html>",
      )) as typeof fetch;
    const page = await fetchPageText("https://example.com/a", { fetchImpl });
    expect(page.title).toBe("测试标题");
    expect(page.text).toContain("正文标题");
    expect(page.text).toContain("第一段。");
    expect(page.text).not.toContain("evil");
    expect(page.text).not.toContain(".x{}");
    expect(page.text).not.toContain("<p>");
  });

  it("caps text length", async () => {
    const fetchImpl = (async () => htmlResponse("<body>" + "长".repeat(20000) + "</body>")) as typeof fetch;
    const page = await fetchPageText("https://example.com/b", { fetchImpl, maxChars: 500 });
    expect(page.text.length).toBeLessThanOrEqual(500);
    expect(page.truncated).toBe(true);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/utils/fetch-page.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现 fetch-page.ts**

```ts
/**
 * 网页正文抓取 — read_url 工具与选题雷达的取数原语。
 * 桌面单用户场景：URL 来自用户/模型，仅协议白名单（http/https），
 * 不做私网 IP 拦截（与用户同信任级，本机权限内）。
 */
import { checkFetchResponse } from "./retry.js";

export interface PageText {
  title: string | null;
  text: string;
  truncated: boolean;
}

export interface FetchPageOptions {
  fetchImpl?: typeof fetch;
  /** 默认 15_000 */
  timeoutMs?: number;
  /** 默认 8_000 */
  maxChars?: number;
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}

export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) || null : null;
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return { title, text };
}

export async function fetchPageText(url: string, opts: FetchPageOptions = {}): Promise<PageText> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("仅支持 http/https 链接");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 链接");
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  let html: string;
  try {
    const res = await fetchImpl(parsed.href, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 AutoCrew/1.0", accept: "text/html,application/xhtml+xml,*/*" },
    });
    checkFetchResponse(res, `read_url ${parsed.hostname}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const { title, text } = htmlToText(html);
  const maxChars = opts.maxChars ?? 8_000;
  const truncated = text.length > maxChars;
  return { title, text: truncated ? text.slice(0, maxChars) : text, truncated };
}
```

- [ ] **Step 4:** `npx vitest run src/utils/fetch-page.test.ts` → PASS。

- [ ] **Step 5: chat-router 加 read_url 工具（测试先行）**

`src/desktop/chat-router.test.ts` 的 `buildChatTools` describe 内追加：

```ts
  it("read_url returns page text to the model and pushes no card", async () => {
    const sink: ChatCard[] = [];
    const fetchPage = vi.fn(async () => ({ title: "对标文章", text: "正文内容……", truncated: false }));
    const tools = buildChatTools(sink, testDir, { fetchPage });

    const out = await tools.find((t) => t.name === "read_url")!.execute({ url: "https://example.com/x" });

    expect(fetchPage).toHaveBeenCalledWith("https://example.com/x");
    const parsed = JSON.parse(out as string);
    expect(parsed).toMatchObject({ ok: true, title: "对标文章" });
    expect(parsed.text).toContain("正文内容");
    expect(sink).toHaveLength(0);
  });

  it("read_url failure returns ok:false", async () => {
    const sink: ChatCard[] = [];
    const fetchPage = vi.fn(async () => { throw new Error("仅支持 http/https 链接"); });
    const tools = buildChatTools(sink, testDir, { fetchPage });
    const out = await tools.find((t) => t.name === "read_url")!.execute({ url: "file:///x" });
    expect(JSON.parse(out as string)).toMatchObject({ ok: false });
  });
```

跑 `npx vitest run src/desktop/chat-router.test.ts` → 新用例 FAIL。

`src/desktop/chat-router.ts`：
- imports 加：

```ts
import { fetchPageText, type PageText } from "../utils/fetch-page.js";
```

- `ChatToolDeps` 加一个注入位：

```ts
  fetchPage?: (url: string) => Promise<PageText>;
```

- `buildChatTools` 的 `d` 对象加：

```ts
    fetchPage: deps?.fetchPage ?? ((url: string) => fetchPageText(url)),
```

- 工具数组（`absorb_style` 之前）加：

```ts
    {
      name: "read_url",
      description: "读取一个网页链接的正文（对标文章/资料），内容可用于写作 research 或风格吸收。",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "http/https 链接" } },
        required: ["url"],
      },
      execute: async (args) => {
        const url = String(sanitize(args).url ?? "").trim();
        if (!url) return fail("缺少 url");
        try {
          const page = await d.fetchPage(url);
          return JSON.stringify({
            ok: true,
            title: page.title,
            truncated: page.truncated,
            text: page.text.slice(0, 4_000), // 进对话上下文的预算上限
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
      },
    },
```

- `SYSTEM_PROMPT` 规则 4 之前插一条（原 4/5 顺延为 5/6）：

```
4. 用户给链接（对标文章、资料）时，先调用 read_url 读取内容，再基于内容写作或吸收风格——不要凭空假装读过。
```

- [ ] **Step 6: 全绿 + Commit**

Run: `npx vitest run src/desktop/chat-router.test.ts src/utils/fetch-page.test.ts && npm run typecheck`
Expected: PASS。

```bash
git add src/utils/fetch-page.ts src/utils/fetch-page.test.ts src/desktop/chat-router.ts src/desktop/chat-router.test.ts
git commit -m "feat: read_url 工具 — 对标链接正文抓取进对话上下文（dogfood 止血）"
```

---

### Task 3: 选题雷达模块 — 源配置 + RSS 解析 + 缓存 + 候选排序

**Files:**
- Create: `src/data/topic-sources.json`
- Create: `src/modules/radar/topic-radar.ts`
- Test: `src/modules/radar/topic-radar.test.ts`
- Modify: `desktop/main.ts`（app 启动 fire-and-forget 刷新）

- [ ] **Step 1: 源配置**

创建 `src/data/topic-sources.json`（v1 两个稳定 RSS 源，schema 预留云端下发——对齐 §6 适配器配置模式）：

```json
{
  "version": 1,
  "sources": [
    { "id": "36kr", "name": "36氪", "type": "rss", "url": "https://36kr.com/feed", "tracks": ["科技", "AI", "创投"] },
    { "id": "ifanr", "name": "爱范儿", "type": "rss", "url": "https://www.ifanr.com/feed", "tracks": ["科技", "AI", "数码"] }
  ]
}
```

- [ ] **Step 2: 写失败测试**

创建 `src/modules/radar/topic-radar.test.ts`：

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseRssItems,
  rankCandidates,
  refreshTopicRadar,
  loadTopicCache,
  getTopicCandidates,
  type RadarItem,
} from "./topic-radar.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-radar-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[OpenAI 发布新模型]]></title><link>https://a.com/1</link><pubDate>Thu, 11 Jun 2026 01:00:00 GMT</pubDate></item>
<item><title>美食探店指南 &amp; 测评</title><link>https://a.com/2</link><pubDate>Thu, 11 Jun 2026 02:00:00 GMT</pubDate></item>
</channel></rss>`;

describe("parseRssItems", () => {
  it("extracts title (CDATA + entity), link, pubDate", () => {
    const items = parseRssItems(RSS);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("OpenAI 发布新模型");
    expect(items[0].link).toBe("https://a.com/1");
    expect(items[1].title).toBe("美食探店指南 & 测评");
    expect(typeof items[1].publishedAt).toBe("string");
  });
});

describe("rankCandidates", () => {
  it("scores industry-token hits above non-hits", () => {
    const now = Date.now();
    const items: RadarItem[] = [
      { title: "AI 编程助手大更新", link: "l1", source: "36氪", publishedAt: new Date(now).toISOString() },
      { title: "城市露营装备清单", link: "l2", source: "36氪", publishedAt: new Date(now).toISOString() },
    ];
    const ranked = rankCandidates(items, "AI技术/科技博主", 10);
    expect(ranked[0].title).toBe("AI 编程助手大更新");
  });

  it("caps at limit and prefers recent items on tie", () => {
    const items: RadarItem[] = Array.from({ length: 20 }, (_, i) => ({
      title: `科技新闻 ${i}`,
      link: `l${i}`,
      source: "36氪",
      publishedAt: new Date(Date.now() - i * 3600_000).toISOString(),
    }));
    const ranked = rankCandidates(items, "科技", 10);
    expect(ranked).toHaveLength(10);
    expect(ranked[0].title).toBe("科技新闻 0");
  });
});

describe("refreshTopicRadar + cache + getTopicCandidates", () => {
  it("fetches all sources, tolerates per-source failure, writes cache", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes("36kr")) return new Response(RSS, { status: 200 });
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await refreshTopicRadar(testDir, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.itemCount).toBe(2);
    expect(result.failedSources).toEqual(["爱范儿"]);

    const cache = await loadTopicCache(testDir);
    expect(cache?.items).toHaveLength(2);
    expect(typeof cache?.fetchedAt).toBe("string");
  });

  it("getTopicCandidates serves from fresh cache without fetching", async () => {
    const fetchImpl = vi.fn(async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
    await refreshTopicRadar(testDir, fetchImpl);
    fetchImpl.mockClear();

    const candidates = await getTopicCandidates("AI技术", testDir, fetchImpl);
    expect(candidates.length).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled(); // 新鲜缓存不触发网络
  });

  it("getTopicCandidates refreshes when cache is missing", async () => {
    const fetchImpl = vi.fn(async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
    const candidates = await getTopicCandidates("科技", testDir, fetchImpl);
    expect(fetchImpl).toHaveBeenCalled();
    expect(candidates.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3:** `npx vitest run src/modules/radar/` → FAIL（模块不存在）。

- [ ] **Step 4: 实现 topic-radar.ts**

```ts
/**
 * 选题雷达 v1（PRD §7.1 增补）— 公开热榜 RSS → 缓存落盘 → 按定位排序候选。
 * 「定期抓取」v1 = app 启动 fire-and-forget + 工具内 TTL 兜底；
 * 真调度器随 L2 定时拟稿上（PRD §4 信任阶梯）。
 * 合规：只读消费公开 RSS，不自建爬虫，不碰登录态（§6 红线）。
 * 评分裁决：本模块只做确定性排序（关键词×新鲜度）；LLM 评分由 loop 里的
 * 模型对 find_topics 返回的候选自然完成，不嵌套调用。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import sourcesJson from "../../data/topic-sources.json" with { type: "json" };

export interface RadarItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
}

export interface TopicCache {
  fetchedAt: string;
  items: RadarItem[];
}

interface RadarSource {
  id: string;
  name: string;
  type: string;
  url: string;
  tracks: string[];
}

const CACHE_FILE = "topic-radar.json";
const CACHE_TTL_MS = 6 * 3600_000;
const FETCH_TIMEOUT_MS = 12_000;

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}

function field(itemXml: string, tag: string): string {
  const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return decodeEntities(m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim());
}

/** RSS 2.0 子集解析（零依赖正则；源不规范时安全降级为空数组） */
export function parseRssItems(xml: string): Array<Omit<RadarItem, "source">> {
  const items: Array<Omit<RadarItem, "source">> = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const title = field(m[0], "title");
    const link = field(m[0], "link");
    if (!title || !link) continue;
    const pub = field(m[0], "pubDate");
    const ts = pub ? new Date(pub) : new Date();
    items.push({ title, link, publishedAt: isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString() });
  }
  return items;
}

/** 确定性候选排序：定位 token 命中 ×3 + 新鲜度（<24h +2, <72h +1） */
export function rankCandidates(items: RadarItem[], industry: string, limit: number): RadarItem[] {
  const tokens = industry.split(/[/\s,，、|]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  const now = Date.now();
  const scored = items.map((item) => {
    let score = 0;
    for (const tok of tokens) {
      if (item.title.toLowerCase().includes(tok.toLowerCase())) score += 3;
    }
    const ageH = (now - new Date(item.publishedAt).getTime()) / 3600_000;
    if (ageH < 24) score += 2;
    else if (ageH < 72) score += 1;
    return { item, score };
  });
  scored.sort(
    (a, b) => b.score - a.score ||
      new Date(b.item.publishedAt).getTime() - new Date(a.item.publishedAt).getTime(),
  );
  return scored.slice(0, limit).map((s) => s.item);
}

function cachePath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), CACHE_FILE);
}

export async function loadTopicCache(dataDir?: string): Promise<TopicCache | null> {
  try {
    return JSON.parse(await fs.readFile(cachePath(dataDir), "utf-8")) as TopicCache;
  } catch {
    return null;
  }
}

export async function refreshTopicRadar(
  dataDir?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; itemCount: number; failedSources: string[] }> {
  const sources = (sourcesJson as { sources: RadarSource[] }).sources;
  const items: RadarItem[] = [];
  const failedSources: string[] = [];

  await Promise.all(
    sources.map(async (src) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(src.url, {
          signal: controller.signal,
          headers: { "user-agent": "Mozilla/5.0 AutoCrew/1.0" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const item of parseRssItems(await res.text())) {
          items.push({ ...item, source: src.name });
        }
      } catch {
        failedSources.push(src.name); // 单源失败不拖垮整体——禁止静默返回空（§6），失败名单上报
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  if (items.length > 0) {
    const dir = getDataDir(dataDir);
    await fs.mkdir(dir, { recursive: true });
    const cache: TopicCache = { fetchedAt: new Date().toISOString(), items };
    await fs.writeFile(cachePath(dataDir), JSON.stringify(cache, null, 2) + "\n");
  }
  return { ok: items.length > 0, itemCount: items.length, failedSources };
}

/** 工具侧入口：新鲜缓存直读；缺失/过期则刷新后排序。 */
export async function getTopicCandidates(
  industry: string,
  dataDir?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  limit = 10,
): Promise<RadarItem[]> {
  let cache = await loadTopicCache(dataDir);
  const stale = !cache || Date.now() - new Date(cache.fetchedAt).getTime() > CACHE_TTL_MS;
  if (stale) {
    await refreshTopicRadar(dataDir, fetchImpl);
    cache = await loadTopicCache(dataDir);
  }
  if (!cache) return [];
  return rankCandidates(cache.items, industry, limit);
}
```

注意：`import ... with { type: "json" }` 若 tsconfig/版本不支持，按仓库 sensitive-words 的既有 JSON 引入方式对齐（grep `src/data` 的现有 import 写法），并在报告说明实际采用形式。

- [ ] **Step 5:** `npx vitest run src/modules/radar/ && npm run typecheck` → PASS。

- [ ] **Step 6: main.ts 启动刷新**

`desktop/main.ts` —— imports 加：

```ts
import { refreshTopicRadar } from "../src/modules/radar/topic-radar.js";
```

`app.whenReady().then(() => {` 内 `createWindow();` 之后加：

```ts
  // 选题雷达：启动 fire-and-forget 刷新（PRD §7.1——定期抓取归外层调度，v1=启动时）
  void refreshTopicRadar().catch(() => {});
```

Run: `npm run build:desktop 2>&1 | tail -2` → 通过（含 ipc-guard 接线 smoke）。

- [ ] **Step 7: Commit**

```bash
git add src/data/topic-sources.json src/modules/radar/ desktop/main.ts
git commit -m "feat: 选题雷达 v1 — RSS 热榜缓存 + 定位排序候选，启动时后台刷新"
```

---

### Task 4: find_topics 工具 + topic 选题卡

**Files:**
- Modify: `src/desktop/chat-router.ts`（find_topics 工具 + ChatCard "topic"）
- Test: `src/desktop/chat-router.test.ts`
- Modify: `desktop/renderer/cards.js`（renderTopicCard）

- [ ] **Step 1: 写失败测试**

`chat-router.test.ts` 的 `buildChatTools` describe 内追加：

```ts
  it("find_topics pushes a topic card and returns compact candidates", async () => {
    const sink: ChatCard[] = [];
    const topics = vi.fn(async () => [
      { title: "OpenAI 新模型", link: "https://a.com/1", source: "36氪", publishedAt: "2026-06-11T01:00:00Z" },
      { title: "AI 编程趋势", link: "https://a.com/2", source: "爱范儿", publishedAt: "2026-06-11T02:00:00Z" },
    ]);
    const tools = buildChatTools(sink, testDir, { topics });

    const out = await tools.find((t) => t.name === "find_topics")!.execute({});

    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]).toMatchObject({ title: "OpenAI 新模型", source: "36氪" });
    expect(parsed.candidates[0].link).toBeUndefined(); // link 不进对话上下文（token 纪律）
    expect(sink).toHaveLength(1);
    expect(sink[0].type).toBe("topic");
    expect((sink[0].data.candidates as unknown[]).length).toBe(2);
  });

  it("find_topics with empty radar returns ok:false guidance", async () => {
    const sink: ChatCard[] = [];
    const topics = vi.fn(async () => []);
    const tools = buildChatTools(sink, testDir, { topics });
    const out = await tools.find((t) => t.name === "find_topics")!.execute({});
    expect(JSON.parse(out as string)).toMatchObject({ ok: false });
    expect(sink).toHaveLength(0);
  });
```

跑确认 FAIL。

- [ ] **Step 2: 实现工具**

`src/desktop/chat-router.ts`：
- imports 加：

```ts
import { getTopicCandidates, type RadarItem } from "../modules/radar/topic-radar.js";
import { loadProfile } from "../modules/profile/creator-profile.js";
```

（注意：`addWritingRule` 的既有 import 行与 loadProfile 合并到同一行。）

- `ChatCard.type` 联合加 `"topic"`：

```ts
  type: "draft" | "report" | "drafts_list" | "style" | "publish" | "published" | "topic";
```

- `ChatToolDeps` 加：

```ts
  topics?: (industry: string) => Promise<RadarItem[]>;
```

- `d` 对象加（默认实现读 profile 定位 → 候选）：

```ts
    topics:
      deps?.topics ??
      (async (industry: string) => getTopicCandidates(industry, dataDir)),
```

- 工具数组（`generate_script` 之前）加：

```ts
    {
      name: "find_topics",
      description: "选题雷达：按创作者的定位/赛道从公开热榜拉取并排序候选选题。用户问「写什么」「找选题」「最近热点」时调用。",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        let industry = "科技";
        try {
          const profile = await loadProfile(dataDir);
          if (profile?.industry) industry = profile.industry;
        } catch {
          /* 无档案用默认赛道 */
        }
        let candidates: RadarItem[];
        try {
          candidates = await d.topics(industry);
        } catch (err) {
          return fail(err instanceof Error ? err.message : err);
        }
        if (candidates.length === 0) {
          return fail("热榜暂时拉不到数据（网络或源不可用），请稍后再试或直接给我选题");
        }
        sink.push({ type: "topic", data: { industry, candidates } });
        return JSON.stringify({
          ok: true,
          industry,
          candidates: candidates.map((c) => ({ title: c.title, source: c.source })),
        });
      },
    },
```

- `SYSTEM_PROMPT` 末尾追加一条规则：

```
7. 用户问「写什么」「找选题」时调用 find_topics，然后从候选里挑 3 个最适合该创作者定位的，用一两句话说明各自为什么值得写。
```

- [ ] **Step 3:** `npx vitest run src/desktop/chat-router.test.ts && npm run typecheck` → PASS。

- [ ] **Step 4: renderTopicCard**

`desktop/renderer/cards.js`：
- `renderCard` switch 加：

```js
    case "topic": return renderTopicCard(card.data);
```

- 文件末尾加：

```js
function renderTopicCard(d) {
  const el = cardShell("选题雷达 · " + (d.industry || ""), "今日候选选题");
  const list = h("ol", { class: "md-list topic-list" });
  const candidates = d.candidates || [];
  for (const c of candidates.slice(0, 10)) {
    const li = h("li", { class: "topic-item" });
    li.appendChild(h("span", {}, c.title + "（" + (c.source || "?") + "）"));
    const writeBtn = h("button", { class: "btn-mini" }, "就这个写");
    writeBtn.addEventListener("click", () => {
      sendChat("用选题《" + c.title + "》给我写一条口播");
    });
    li.appendChild(writeBtn);
    list.appendChild(li);
  }
  el.appendChild(list);
  return el;
}
```

- `desktop/renderer/style.css` 末尾追加：

```css
.topic-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}
```

- [ ] **Step 5: 验证 + Commit**

Run: `node --check desktop/renderer/cards.js && npm run check 2>&1 | tail -3 && npm run build:desktop 2>&1 | tail -2`
Expected: 全绿。

```bash
git add src/desktop/chat-router.ts src/desktop/chat-router.test.ts desktop/renderer/cards.js desktop/renderer/style.css
git commit -m "feat: find_topics 工具 + 选题卡 — 「帮我找选题」承诺兑现，就这个写=双通道"
```

---

### Task 5: 知识库轻版 — 检索注入 + knowledge:status 通道 + 设置入口

**Files:**
- Create: `src/modules/knowledge/knowledge-base.ts`
- Test: `src/modules/knowledge/knowledge-base.test.ts`
- Modify: `src/tools/generate.ts:103-110`（注入接线）
- Modify: `src/desktop/channels.ts`、`src/desktop/ipc.ts`（knowledge:status，通道 17→18）
- Test: `src/desktop/ipc.test.ts`
- Modify: `desktop/renderer/settings.js`（入口说明）

- [ ] **Step 1: 写失败测试（knowledge-base）**

创建 `src/modules/knowledge/knowledge-base.test.ts`：

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { retrieveKnowledge, knowledgeStatus } from "./knowledge-base.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-knowledge-test-"));
  await fs.mkdir(path.join(testDir, "knowledge"));
  await fs.writeFile(path.join(testDir, "knowledge", "ai-agents.md"), "Agent 的核心是工具调用循环。预算上限很重要。");
  await fs.writeFile(path.join(testDir, "knowledge", "cooking.txt"), "红烧肉要先焯水，冰糖炒糖色。");
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("retrieveKnowledge", () => {
  it("returns excerpts from files matching topic tokens, skips unrelated", async () => {
    const result = await retrieveKnowledge("Agent 工具调用怎么讲", testDir);
    expect(result).not.toBeNull();
    expect(result).toContain("工具调用循环");
    expect(result).not.toContain("红烧肉");
  });

  it("returns null when no knowledge dir or no match", async () => {
    expect(await retrieveKnowledge("量子物理", testDir)).toBeNull();
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-knowledge-empty-"));
    expect(await retrieveKnowledge("任何主题", emptyDir)).toBeNull();
    await fs.rm(emptyDir, { recursive: true, force: true });
  });

  it("caps total excerpt length", async () => {
    await fs.writeFile(path.join(testDir, "knowledge", "big.md"), "Agent " + "知识".repeat(5000));
    const result = await retrieveKnowledge("Agent", testDir, { maxChars: 500 });
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(700); // 500 正文 + 头部格式余量
  });
});

describe("knowledgeStatus", () => {
  it("reports dir and file count", async () => {
    const status = await knowledgeStatus(testDir);
    expect(status.count).toBe(2);
    expect(status.dir.endsWith("knowledge")).toBe(true);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/modules/knowledge/` → FAIL。

- [ ] **Step 3: 实现 knowledge-base.ts**

```ts
/**
 * 知识库轻版（PRD §7.1「轻量没入式知识库」）— 本地目录扔文件即条目。
 * <dataDir>/knowledge/ 下的 .md/.txt，按选题 token 重叠度选 top-k，
 * 截取片段注入生成 prompt 的 research 槽。无 embedding（YAGNI——
 * 文件量级是十位数；语义检索随知识库正式版裁决）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";

export interface KnowledgeOptions {
  /** 默认 3 */
  maxFiles?: number;
  /** 全部片段合计字符预算，默认 2000 */
  maxChars?: number;
}

export function knowledgeDir(dataDir?: string): string {
  return path.join(getDataDir(dataDir), "knowledge");
}

function tokenize(text: string): string[] {
  return text
    .split(/[\s/,，、。！？!?．.:：;；()（）\[\]【】"'`]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
}

export async function knowledgeStatus(dataDir?: string): Promise<{ dir: string; count: number }> {
  const dir = knowledgeDir(dataDir);
  try {
    const files = await fs.readdir(dir);
    return { dir, count: files.filter((f) => /\.(md|txt)$/i.test(f)).length };
  } catch {
    return { dir, count: 0 };
  }
}

export async function retrieveKnowledge(
  topic: string,
  dataDir?: string,
  opts: KnowledgeOptions = {},
): Promise<string | null> {
  const dir = knowledgeDir(dataDir);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((f) => /\.(md|txt)$/i.test(f));
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  const topicTokens = tokenize(topic);
  if (topicTokens.length === 0) return null;

  const scored: Array<{ name: string; content: string; score: number }> = [];
  for (const name of names) {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, name), "utf-8");
    } catch {
      continue;
    }
    const haystack = (name + "\n" + content).toLowerCase();
    let score = 0;
    for (const tok of topicTokens) {
      if (haystack.includes(tok)) score += 1;
    }
    if (score > 0) scored.push({ name, content, score });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, opts.maxFiles ?? 3);
  const budget = opts.maxChars ?? 2_000;
  const per = Math.floor(budget / top.length);
  const parts = top.map((f) => `《${f.name}》：${f.content.slice(0, per).trim()}`);
  return `【知识库参考】\n${parts.join("\n---\n")}`;
}
```

- [ ] **Step 4:** `npx vitest run src/modules/knowledge/` → PASS。

- [ ] **Step 5: generate.ts 接线（测试先行）**

`src/tools/generate.test.ts`（先读该文件确认 deps 注入模式——executeGenerate 有 `deps.generateScriptImpl` 注入位）末尾追加：

```ts
describe("knowledge injection", () => {
  it("appends knowledge excerpts to research when knowledge dir matches topic", async () => {
    const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-gen-knowledge-"));
    await fs.mkdir(path.join(testDir, "knowledge"), { recursive: true });
    await fs.writeFile(path.join(testDir, "knowledge", "agent.md"), "工具调用循环是 Agent 的核心。");

    let capturedReq: Record<string, unknown> | null = null;
    const generateScriptImpl = async (req: Record<string, unknown>) => {
      capturedReq = req;
      return { contentId: "c1", title: "t", body: "b", hashtags: [], violations: [], tokensUsed: 1 };
    };

    await executeGenerate(
      { action: "script", topic: "Agent 工具调用", platform: "douyin", research: "用户给的资料", _dataDir: testDir },
      { generateScriptImpl } as never,
    );

    expect(capturedReq).not.toBeNull();
    const research = String((capturedReq as { research?: string }).research);
    expect(research).toContain("用户给的资料");
    expect(research).toContain("知识库参考");
    expect(research).toContain("工具调用循环");
    await fs.rm(testDir, { recursive: true, force: true });
  });
});
```

（import 区按该文件既有模式补 fs/os/path；executeGenerate 的 deps 第二参形状以文件内既有用例为准对齐，断言不变。）

跑确认 FAIL。然后改 `src/tools/generate.ts`：在构建 req 之前先取 dataDir 与知识片段（imports 加 `import { retrieveKnowledge } from "../modules/knowledge/knowledge-base.js";`）：

```ts
  const dataDir = (params._dataDir as string) || undefined;
  const knowledge = await retrieveKnowledge(topic.trim(), dataDir);
  const researchParts = [params.research as string | undefined, knowledge].filter(
    (s): s is string => Boolean(s),
  );

  const req: ScriptRequest = {
    topic: topic.trim(),
    platform: platformRaw,
    research: researchParts.length > 0 ? researchParts.join("\n\n") : undefined,
  };
```

（原 109 行 `const dataDir = ...` 删除——已上移；其余不动。）

- [ ] **Step 6: knowledge:status 通道（测试先行）**

`ipc.test.ts`：EXPECTED 加 `"knowledge:status"`，通道数断言 17→18，CHANNEL_ACTIONS 排除清单加之。末尾追加：

```ts
describe("knowledge:status handler", () => {
  it("returns dir and count", async () => {
    const handlers = buildIpcHandlers();
    const res = await handlers["knowledge:status"]({ _dataDir: testDir });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).count).toBe(0);
  });
});
```

跑 FAIL 后实现：`channels.ts` 加 `"knowledge:status",`（注释 17→18，方法列表补 knowledgeStatus）；`ipc.ts` imports 加 `import { knowledgeStatus } from "../modules/knowledge/knowledge-base.js";`，handler 区加：

```ts
// ── knowledge:status — 知识库入口状态（设置页展示） ──────────────────────────

async function knowledgeStatusHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    return { ok: true, data: await knowledgeStatus((payload._dataDir as string) || undefined) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

defaults 加 `"knowledge:status": knowledgeStatusHandler,`；头注释 payload keys 补 `knowledge:status {}`。

- [ ] **Step 7: 设置页入口**

`desktop/renderer/settings.js` —— `initSettings` 内开发者区 `el.appendChild(dev);` 之后加：

```js
  // 知识库入口（PRD §7.1 轻量没入式知识库）
  const kb = await safeInvoke(window.autocrew.knowledgeStatus);
  if (kb.ok && kb.data) {
    const kbBox = h("div", { class: "dev-zone" });
    kbBox.appendChild(h("h3", {}, "知识库"));
    kbBox.appendChild(h("p", { class: "muted" },
      "把你的笔记/干货文档（.md / .txt）放进 " + kb.data.dir + "，生成时自动检索注入。当前 " + kb.data.count + " 个文件。"));
    el.appendChild(kbBox);
  }
```

（`.dev-zone` 样式复用作信息框，div 无 summary 不折叠——可接受。）

- [ ] **Step 8: 全绿 + Commit**

Run: `npm run check 2>&1 | tail -3 && node --check desktop/renderer/settings.js && npm run build:desktop 2>&1 | tail -2`
Expected: 全绿（18 通道）。

```bash
git add src/modules/knowledge/ src/tools/generate.ts src/tools/generate.test.ts src/desktop/ desktop/renderer/settings.js
git commit -m "feat: 知识库轻版 — 本地目录检索注入生成 prompt，设置页入口"
```

---

### Task 6: 报错/loading 文案清单 + runbook + 全量回归

**Files:**
- Modify: `desktop/renderer/chat.js`
- Modify: `desktop/renderer/onboarding.js`
- Modify: `docs/dogfood-runbook.md`

- [ ] **Step 1: 文案修正（三处精确修改）**

1. `chat.js` 的 `sendChat` 中 thinking 占位：

```js
  const thinking = appendChatMessage("assistant", "正在干活…（写稿约需 30-60 秒）");
```

2. `chat.js` 的通用错误分支：

```js
      appendChatMessage("assistant", "出错了：" + (res.error || "未知错误") + "。可以直接重发，或到右侧「设置」检查引擎配置。");
```

3. `onboarding.js` 的 `dialogPickFile` 静默失败补 toast——`onboardingStepImport` 内：

```js
    const picked = await safeInvoke(window.autocrew.dialogPickFile);
    if (!picked.ok) {
      showToast(picked.error || "文件选择不可用");
      return;
    }
    if (!picked.data || !picked.data.path) return; // 用户取消，静默
```

- [ ] **Step 2: runbook 增补**

`docs/dogfood-runbook.md` 的「十一、桌面壳 v2」一节末尾追加：

```markdown

### Sprint 1 新增（2026-06-11）

- **对话支持 markdown**：助手回复的粗体/列表/标题/代码正常渲染（链接/HTML 按纯文本显示——安全纪律）。
- **读链接**：对话里给 http(s) 链接 +「照这个风格写」/「参考这篇写」，read_url 工具自动读正文。
- **选题雷达**：问「写什么」「帮我找选题」→ 按你的定位从公开热榜（36氪/爱范儿，启动时后台刷新，6h TTL）出候选选题卡，点「就这个写」直接进生成。源清单在 `src/data/topic-sources.json`。
- **知识库**：把 .md/.txt 干货文档放进 `~/.autocrew/knowledge/`，生成时按选题自动检索注入（设置页可看文件计数）。
```

- [ ] **Step 3: 全量回归**

Run: `npm run check && npm run build:desktop 2>&1 | tail -2 && for f in desktop/renderer/*.js; do node --check $f; done`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add desktop/renderer/chat.js desktop/renderer/onboarding.js docs/dogfood-runbook.md
git commit -m "fix: 报错/loading 文案清单；docs: runbook Sprint 1 使用路径"
```

---

## Self-Review 记录

- **Spec 覆盖**：roadmap S1 五项 ↔ Task 1（markdown）、Task 2（read_url）、Task 3+4（选题雷达：缓存/排序/工具/卡片/启动刷新）、Task 5（知识库 + 设置入口）、Task 6（报错清单）。PRD §7.1 增补的三个口径全部落实：工具/调度分离（Task 3 Step 6 启动刷新 + 工具 TTL 兜底）、公开源只读（两 RSS 源 + 失败名单上报不静默）、LLM 评分不嵌套（候选回给 loop 模型）。
- **已知妥协（显式）**：RSS 正则解析对不规范源安全降级为空（计入 failedSources）；知识库无 embedding（文件十位数量级，token 重叠够用）；真调度器推迟到 L2；topic-sources.json 编译进包（云端下发结构已预留，接薄云后端时切换）；36kr/爱范儿 RSS 的可达性依赖网络环境——单源挂不影响另一源。
- **类型一致性**：`RadarItem` 在 topic-radar/chat-router 间共享 import；`ChatCard.type` 七值与 cards.js switch 七分支对应；`PageText` 共享；deps 注入位命名 fetchPage/topics 与测试一致；通道数 17→18 仅 Task 5 改一次。
- **基线注意**：Task 5 改 `generate.ts` 的 dataDir 声明位置（上移），Task 3 改 main.ts（必须跑 build:desktop 的 ipc-guard smoke）。
