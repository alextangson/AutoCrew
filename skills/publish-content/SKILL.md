---
name: publish-content
description: |
  Publish approved content to social media platforms. Activate when user asks to publish, post, or distribute content. Trigger: "发布" / "发到小红书" / "帮我发" / "发布这篇". Supports Xiaohongshu, Douyin, WeChat Video, WeChat MP (公众号).
---

# 发布内容

> 工具型技能。双模式：复制粘贴格式化（通用）+ 浏览器自动化（OpenClaw MCP Browser）。

## 功能矩阵

| Feature | OpenClaw | Claude Code |
|---------|----------|-------------|
| Pre-publish validation | ✅ | ✅ |
| Format for copy-paste | ✅ | ✅ |
| Browser automation publish | ✅ (MCP Browser) | ❌ (manual) |
| Status tracking | ✅ | ✅ |

## 关键规则（浏览器自动化）

1. **Navigate by URL**, not by clicking menus (menus are unreliable in accessibility tree).
2. **Wait 5 seconds** after each navigation for page to load.
3. **Video upload uses `input[type=file]`** — find the hidden file input via `evaluate`, then use `setInputFiles`. NEVER try drag-and-drop.
4. **Cover image upload** — same approach: find `input[type=file]` for cover, use `setInputFiles`.
5. **Truncate content** to platform limits silently. Add "…" if truncated.
6. **Respond in Simplified Chinese** for all user-facing messages.

## 平台路由

| Platform | Upload/Create URL | Login Detection |
|----------|------------------|-----------------|
| xiaohongshu | `https://creator.xiaohongshu.com/publish/publish` | URL contains `/login` |
| douyin | `https://creator.douyin.com/creator-micro/content/upload` | URL redirects to `sso.douyin.com` |
| wechat_video | `https://channels.weixin.qq.com/platform/post/create` | URL redirects to `/login.html` |
| wechat_mp | `https://mp.weixin.qq.com/` | URL contains `/login` or no cookie |

## 平台限制

| Platform | Title limit | Body limit | Tags |
|----------|------------|-----------|------|
| xiaohongshu | 20 chars | 1000 chars | 5-15 |
| douyin | 30 chars | 1000 chars | 5 |
| wechat_video | — (描述 only) | 1000 chars | 5 |
| wechat_mp | 64 chars | 20000 chars | — |

---

## 第零步：确定要发布的内容

1. List content: `autocrew_content` action="list"
2. Filter for status="approved" (or "draft" if user explicitly asks)
3. IF no content → tell user to write some first.
4. Load the content project: `autocrew_asset` action="list" content_id=xxx to check for cover/video assets.

## 第一步：发布前校验

Check content against platform limits. Auto-truncate with "…" if over limit.

Check required assets:
- xiaohongshu image note: needs at least 1 image
- douyin: needs video
- wechat_video: needs video
- wechat_mp: text only is fine

IF missing required assets → ask user to provide them, or use `autocrew_asset` action="add" to register.

## 第二步：路由到模式

- IF browser automation available (OpenClaw MCP Browser) AND user wants auto-publish → go to **Browser Automation Steps**
- ELSE → go to **Copy-Paste Mode**

---

## 复制粘贴模式（通用）

格式化内容供用户手动发布，在聊天中输出。

### 小红书格式：
<output_template lang="zh-CN">
```
📋 小红书发布内容：

标题：{title}

正文：
{body}

标签：#tag1 #tag2 #tag3 #tag4 #tag5

📎 封面：{cover asset path or "需要手动上传"}
🔗 发布地址：https://creator.xiaohongshu.com/publish/publish
```
</output_template>

### 抖音格式：
<output_template lang="zh-CN">
```
📋 抖音发布内容：

作品描述：{title}
简介：{body_truncated_1000}
标签：#tag1 #tag2 #tag3

📎 视频：{video asset path}
📎 封面：{cover asset path or "使用自动封面"}
🔗 发布地址：https://creator.douyin.com/creator-micro/content/upload
```
</output_template>

### 视频号格式：
<output_template lang="zh-CN">
```
📋 视频号发布内容：

创作描述：
{title}
{body_truncated_900}

#tag1 #tag2 #tag3

📎 视频：{video asset path}
🔗 发布地址：https://channels.weixin.qq.com/platform/post/create
```
</output_template>

### 公众号格式：
<output_template lang="zh-CN">
```
📋 公众号发布内容：

标题：{title}
正文：
{body_with_formatting}

📎 封面：{cover asset path or "需要手动上传"}
🔗 发布地址：https://mp.weixin.qq.com/
```
</output_template>

After outputting, update status:
```json
{ "action": "update", "id": "content-xxx", "status": "published" }
```

---

## 浏览器自动化流程（仅 OpenClaw）

### 通用：导航并检查登录

```json
{"action": "navigate", "targetUrl": "<platform create URL>"}
```

Wait 5 seconds. Take snapshot.

- IF URL matches login detection pattern → tell user: "平台登录已过期，请手动登录后重试。"
- ELSE → continue to platform-specific steps.

---

### 抖音步骤

> URL: `https://creator.douyin.com/creator-micro/content/upload`
> After video upload, auto-redirects to `/content/publish`

**D1: Upload video**

Find file input and upload:
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const input = document.querySelector('input[type=file][accept*=video], input[type=file][accept*=mp4]'); if (input) { input.style.display = 'block'; return 'found'; } return 'not_found'; })()"
  }
}
```

Get video path from project assets, then:
```json
{
  "action": "act",
  "request": {
    "kind": "setInputFiles",
    "selector": "input[type=file][accept*=video], input[type=file][accept*=mp4]",
    "files": ["<video_path>"]
  }
}
```

Wait for upload (poll every 5s, up to 120s). Check if URL changes to `/content/publish`.

**D2: Fill form**

Title (作品描述, max 30 chars):
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const input = document.querySelector('input[placeholder*=标题], input[placeholder*=作品]'); if (input) { const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; nativeSet.call(input, '<title_30>'); input.dispatchEvent(new Event('input', {bubbles: true})); return 'filled'; } return 'not_found'; })()"
  }
}
```

Description (简介, max 1000 chars) — contenteditable div:
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const editors = document.querySelectorAll('[contenteditable=true]'); for (const ed of editors) { if (ed.offsetHeight > 50) { ed.focus(); ed.textContent = '<description_1000>'; ed.dispatchEvent(new Event('input', {bubbles: true})); return 'filled'; } } return 'not_found'; })()"
  }
}
```

Tags — append to description or find tag input:
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const editors = document.querySelectorAll('[contenteditable=true]'); for (const ed of editors) { if (ed.textContent.includes('添加话题') || ed.closest('[class*=topic]')) { ed.focus(); const tags = ['tag1','tag2','tag3']; tags.slice(0,5).forEach(t => { ed.textContent += ' #' + t; }); ed.dispatchEvent(new Event('input', {bubbles: true})); return 'added'; } } return 'not_found'; })()"
  }
}
```

**D3: Set cover** (if cover asset exists)

Find cover file input:
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const inputs = document.querySelectorAll('input[type=file][accept*=image]'); for (const inp of inputs) { const parent = inp.closest('[class*=cover], [class*=poster]'); if (parent) { inp.style.display = 'block'; return 'found'; } } return 'not_found'; })()"
  }
}
```

Then `setInputFiles` with cover path. Wait 3s.

**D4: Publish**
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const btns = document.querySelectorAll('button'); for (const b of btns) { if (b.textContent.trim() === '发布' && !b.disabled) { b.click(); return 'clicked'; } } return 'not_found'; })()"
  }
}
```

Wait 5s. Verify success (redirect to content management or success message).

---

### 小红书步骤

> URL: `https://creator.xiaohongshu.com/publish/publish`
> Tabs: 上传视频 / 上传图文 / 写长文 (tabs NOT in accessibility tree, use JS click)

**X1: Switch tab if needed**

IF no video (image note) → switch to "上传图文":
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const tabs = document.querySelectorAll('[class*=tab] span, [role=tab]'); for (const t of tabs) { if (t.textContent.includes('上传图文')) { t.click(); return 'switched'; } } return 'not_found'; })()"
  }
}
```

**X2: Upload media**

Video or images via `input[type=file]` + `setInputFiles`. Same pattern as Douyin.

**X3: Fill form**

Title (max 20 chars):
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const input = document.querySelector('input[placeholder*=标题], input[class*=title]'); if (input) { const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; nativeSet.call(input, '<title_20>'); input.dispatchEvent(new Event('input', {bubbles: true})); return 'filled'; } return 'not_found'; })()"
  }
}
```

Body (max 1000 chars) — contenteditable:
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const editors = document.querySelectorAll('[contenteditable=true], textarea[placeholder*=正文]'); for (const ed of editors) { if (ed.offsetHeight > 80 || ed.tagName === 'TEXTAREA') { ed.focus(); if (ed.tagName === 'TEXTAREA') { ed.value = '<body_1000>'; } else { ed.textContent = '<body_1000>'; } ed.dispatchEvent(new Event('input', {bubbles: true})); return 'filled'; } } return 'not_found'; })()"
  }
}
```

Tags — append `#tag1 #tag2` to body, or find tag input and Enter each tag.

**X4: Publish**
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const btns = document.querySelectorAll('button'); for (const b of btns) { const t = b.textContent.trim(); if ((t === '发布' || t === '发布笔记') && !b.disabled) { b.click(); return 'clicked'; } } return 'not_found'; })()"
  }
}
```

---

### 视频号步骤

> URL: `https://channels.weixin.qq.com/platform/post/create`

**W1: Upload video** — same `input[type=file]` + `setInputFiles` pattern.

**W2: Fill 创作描述** — combine title + body + tags into one field (no separate title):
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const editors = document.querySelectorAll('[contenteditable=true], textarea'); for (const ed of editors) { if (ed.offsetHeight > 50) { ed.focus(); const text = '<title>\\n<body_900>\\n\\n#tag1 #tag2 #tag3'; if (ed.tagName === 'TEXTAREA') { ed.value = text; } else { ed.textContent = text; } ed.dispatchEvent(new Event('input', {bubbles: true})); return 'filled'; } } return 'not_found'; })()"
  }
}
```

**W3: Set cover** — find cover file input if custom cover exists.

**W4: Toggle 原创声明** (if original content):
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const switches = document.querySelectorAll('[role=switch], input[type=checkbox]'); for (const s of switches) { if (s.closest('label')?.textContent?.includes('原创')) { if (!s.checked) { s.click(); return 'toggled'; } return 'already_on'; } } return 'not_found'; })()"
  }
}
```

**W5: Publish** — button text is "发表":
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const btns = document.querySelectorAll('button'); for (const b of btns) { if ((b.textContent.trim() === '发表' || b.textContent.trim() === '发布') && !b.disabled) { b.click(); return 'clicked'; } } return 'not_found'; })()"
  }
}
```

---

### 公众号步骤

> URL: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77`
> This is the "图文消息" editor. Navigate via: 内容与互动 → 图文消息 → 写新图文

**M1: Navigate to new article editor**

```json
{"action": "navigate", "targetUrl": "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77"}
```

Wait 5s. If redirected to login → tell user to log in manually.

**M2: Fill title**

```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const input = document.querySelector('#title, input[placeholder*=标题], input[name=title]'); if (input) { const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; nativeSet.call(input, '<title_64>'); input.dispatchEvent(new Event('input', {bubbles: true})); return 'filled'; } return 'not_found'; })()"
  }
}
```

**M3: Fill body**

The MP editor uses a rich text iframe or contenteditable. Fill with formatted content:

```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const editor = document.querySelector('#edui1_body, [contenteditable=true][class*=rich], .edui-body-container'); if (editor) { editor.innerHTML = '<formatted_html_body>'; editor.dispatchEvent(new Event('input', {bubbles: true})); return 'filled'; } const iframe = document.querySelector('#ueditor_0, iframe[class*=edui]'); if (iframe) { const doc = iframe.contentDocument || iframe.contentWindow.document; const body = doc.querySelector('body[contenteditable=true], body'); if (body) { body.innerHTML = '<formatted_html_body>'; return 'filled_iframe'; } } return 'not_found'; })()"
  }
}
```

Note: MP body supports HTML formatting. Convert markdown to HTML:
- `## heading` → `<h2>heading</h2>`
- `**bold**` → `<strong>bold</strong>`
- Paragraphs → `<p>text</p>`
- Blank lines → `<p><br></p>`

**M4: Set cover image**

Find the cover upload area (usually at the top of the editor):
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const inputs = document.querySelectorAll('input[type=file][accept*=image]'); for (const inp of inputs) { inp.style.display = 'block'; return 'found'; } return 'not_found'; })()"
  }
}
```

Then `setInputFiles` with cover path.

**M5: Preview and publish**

MP has a two-step flow: "预览" then "群发" or "发布".

For draft save (safer):
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const btns = document.querySelectorAll('button, a'); for (const b of btns) { const t = b.textContent.trim(); if (t === '保存' || t === '保存草稿') { b.click(); return 'saved_draft'; } } return 'not_found'; })()"
  }
}
```

For direct publish:
```json
{
  "action": "act",
  "request": {
    "kind": "evaluate",
    "fn": "(() => { const btns = document.querySelectorAll('button, a'); for (const b of btns) { const t = b.textContent.trim(); if (t === '群发' || t === '发布') { b.click(); return 'clicked'; } } return 'not_found'; })()"
  }
}
```

---

## 通用：更新状态

After publish (success or failure), update content status:

```json
{ "action": "update", "id": "content-xxx", "status": "published" }
```

Output:
```
✅ 已发布到{platform_label}
```
or
```
❌ 发布失败：{error_message}。请检查账号状态后重试。
```

## 选择器适配策略

DOM 选择器基于 2026 年初观察到的页面结构。**页面会变。**

当选择器返回 `not_found` 时：
1. 用 `browser snapshot` 查看当前页面结构
2. 通过 role、placeholder 或相邻标签定位正确元素
3. 适配选择器
4. 核心模式不变：evaluate → 找元素 → 填写/点击

关键提示：
- **Douyin**: Title placeholder "填写作品标题". Publish button "发布".
- **Xiaohongshu**: Title placeholder contains "标题". Publish button "发布" or "发布笔记".
- **WeChat Video**: One main text area (创作描述). Publish button "发表".
- **WeChat MP**: Title input `#title`. Body in iframe or contenteditable. Save "保存", publish "群发".

## 错误处理

| 故障 | 处理 |
|------|------|
| 登录过期（重定向） | 告诉用户手动登录 |
| 上传超时（>120s） | 报告失败，建议重试 |
| 验证码弹窗 | 报告失败，建议手动登录 |
| 表单校验错误 | 从 DOM 读取错误信息，报告给用户 |
| 内容过长 | 截断到限制 + "…"，继续 |
| `setInputFiles` 失败 | 尝试页面上所有 `input[type=file]` |
| 找不到发布按钮 | 用 snapshot 找到正确按钮 |
| 浏览器不可用 | 回退到复制粘贴模式 |

## 变更日志

- 2026-03-31: v1 — Adapted from Qingmo publish-content.md v2. Added WeChat MP (公众号) support. Dual-mode: copy-paste + browser automation. Removed backend API dependency. Assets loaded from local project directory.
