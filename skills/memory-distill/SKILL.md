---
name: memory-distill
description: |
  Learn from user feedback to improve future content. Activate when user approves, rejects, edits, or gives feedback on topics or content drafts. Also runs periodically to consolidate learnings.
---

# 记录创作者反馈

把用户对这篇稿的真实评价与修改要求保留下来，避免下一轮又犯同样的问题。模型审稿结论不能冒充用户反馈。

1. 用户说“好”时先识别对象：可能是在同意继续、选角或确认理解，不自动当作成稿采纳。仅明确评价当前稿件时记录 verdict。
2. 对目标稿调用 `autocrew_editorial {action:"inspect", content_id}`，读取当前 `draft_hash` 与已有反馈，确保意见指向用户正在看的版本。
3. 使用一次稳定的 `event_id`，带原话与准确范围提交：

```json
{
  "action":"feedback",
  "content_id":"…",
  "draft_hash":"…",
  "event_id":"feedback-20260922-01",
  "feedback":"用户的原话",
  "scope":"draft",
  "user_confirmed":true
}
```

调用 `autocrew_editorial`，event_id 只用字母、数字、下划线或连字符；示例标识应换成这次反馈的唯一稳定值。重试复用同一 event_id 和同一载荷；不要每轮轮询都造新反馈。稿件已经变化时重新 inspect 并确认意见仍对应新版本，不把旧稿认可套到新稿。

4. 范围：默认 `draft`，只约束当前文章。“以后小红书都这样”才用 `platform` 并带正确 platform；用户明确说跨平台的长期表达才用 `voice`。本篇“短一点”不能自动变成永久偏好。
5. 仅按用户明确结果设置 `verdict`：`adopted`（直接能用）、`light_edit`（小改能用）、`rewritten`（基本重写）、`rejected`（打回）。不从模型分数、工具成功或发布数据推定采纳。
6. 读取返回结果，说明记录了哪条、作用哪里；如没有成功，不能说“我已记住”。反馈不自动等于改稿或批准发布；需要改稿时保留该反馈进完整 requirements，带原 content_id、topic_id、platform 和 force:true 重新领包并按 `write-script` 提交，保留同一篇稿件。

创作者档案和校准走 `autocrew_editorial profile/update_profile`；不直接追加本地 MEMORY 或 profile 文件。性能表现只作为带来源的数据事实，单篇高赞不能证明某种写法普遍有效。
