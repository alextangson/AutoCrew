---
name: humanizer-zh
description: |
  中文去AI味 skill。社媒内容完稿前必须过一遍。优先调用 `autocrew_humanize`，把 AI 痕迹清掉，再决定是否需要人工二次润色。
---

# Humanizer ZH

## Purpose

Make Chinese social content feel less generic, less essay-like, and closer to natural human expression.

## Rules

1. Run this as the final pass after writing or rewriting.
2. Prefer the `autocrew_humanize` tool over manual cleanup.
3. If the output still sounds generic, do one more focused rewrite instead of adding more buzzwords.

## Tool Usage

For a saved draft:

```json
{
  "action": "humanize_zh",
  "content_id": "content-xxx",
  "save_back": true
}
```

For raw text:

```json
{
  "action": "humanize_zh",
  "text": "待处理文本"
}
```

## Completion

Report:

- how many classes of issues were fixed
- the top 3-5 meaningful changes
