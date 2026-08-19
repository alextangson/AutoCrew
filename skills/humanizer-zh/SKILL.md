---
name: humanizer-zh
surfaces: gui, harness
gui_summary: 稿子读着有 AI 味时用——去套话、去论文腔、改回人话
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

## GUI

**什么时候用**：稿子读着像 AI 写的——用户说「太 AI 味了」「这段太官腔」「口语一点」，或你自己读完觉得干净得不像人写的。这是成稿前的最后一道，不是重写。

### 方法论：去 AI 味不是换词，是换说话方式

三个判据，按这个顺序看：

1. **不泛泛**：每段有没有具体的人、事、数字、场景。通篇「随着……的发展」「在这个时代」就是空的。
2. **不像论文**：AI 爱写总分总、爱用「首先/其次/最后」排队、爱「综上所述」收尾、爱拿「我们」起句。人说话是想到哪说到哪，有停顿、有插话、有半句。
3. **像人在说**：句子长度要参差（AI 写出来的句子长度齐得反常），该短就短到三个字；敢用口语、敢自嘲、敢把结论直接拍在开头。

常见 AI 痕迹清单：套话词（值得一提、综上所述、赋能、闭环、生态）、顺序词开头、排比堆砌、每段一样长、结尾必升华。

**关键纪律**：一轮改不干净，就再来一轮**指名到段、到句**的重写——不要靠加更多形容词和金句去补，那只会更 AI。

### 步骤

1. 先确定改哪一篇：上下文里有当前稿件 id 就是它；不确定先 `list_drafts` 让用户指认。动手前用 `get_draft` 读全文。
2. **有「当前修改焦点」时**（用户在编辑器里选了一段或点了「改这篇」）→ 一律走 `revise_focus`，不要用 `revise_draft`（规则见 system prompt 第 3.5 条）。要求不明确先反问一句、别硬改；它出的是提案、不直接保存，改完提示用户在编辑器看红绿 diff、满意点「收下这版」。
3. **没有焦点** → `revise_draft`。`instruction` 要写清楚具体判据（「删掉首先其次最后、把第二段的空话换成那个客户的例子、句长打散」），别只丢一句「去 AI 味」。它会原地存成新版本。
4. 改完自己再读一遍：还是顺得发假，就按第 2/3 步再来一轮聚焦重写。
5. 用户这条意见是长期偏好（「以后都别用排比」）→ 顺手 `add_style_rule` 记一条，下次写稿自动生效。
6. 收尾报告：修了哪几类问题、最值得看的 3-5 处改动。别复述全文。
