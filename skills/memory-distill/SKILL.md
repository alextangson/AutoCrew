---
name: memory-distill
description: |
  Learn from user feedback to improve future content. Activate when user approves, rejects, edits, or gives feedback on topics or content drafts. Also runs periodically to consolidate learnings.
---

# 记忆蒸馏

> 工具型技能。将用户偏好和写作反馈沉淀到持久记忆中。

## 记忆架构

- **L1 — ~/.autocrew/MEMORY.md** (≤120 lines): Working memory. Brand profile, audience, account status, writing preferences summary.
- **L2 — ~/.autocrew/memory/**: Detailed logs and digests. Referenced on demand.

## 触发时机

- User approves or rejects a topic
- User edits a draft significantly
- User gives explicit feedback ("太正式了", "多用emoji", "短一点")
- User shares performance data ("这条笔记1000赞")

## 流程

### 反馈捕捉

1. Identify the feedback signal:
   - Approval: user says "好" / "可以" / "就这个" → positive signal
   - Rejection: user says "不行" / "太..." / "换一个" → negative signal
   - Edit: user provides a rewrite → compare original vs edit
   - Performance: user shares metrics → high/low performance signal

2. Analyze what the user liked or disliked. Be specific:
   - Bad: "user likes emoji"
   - Good: "user prefers 3-5 emoji per XHS post, placed at paragraph starts, favorites: 🔥 💡 ✨"

3. Formulate a learning as a concise preference statement.

4. Read `~/.autocrew/MEMORY.md`. Append the learning to the appropriate section:

Prefer using `autocrew_memory`:

```json
{
  "action": "capture_feedback",
  "content_id": "content-xxx",
  "signal_type": "edit",
  "feedback": "太正式了",
  "modified_text": "用户改后的版本"
}
```

   ```markdown
   ## Writing Preferences
   - [Date] XHS posts: user prefers casual tone, 3-5 emoji, short paragraphs
   - [Date] Titles: user likes curiosity-gap style, dislikes clickbait

   ## Content Edit Preferences
   - [Date] Shortened opening from 3 sentences to 1 — user prefers immediate hooks
   - [Date] Replaced formal "综上所述" with casual "所以说" — user wants conversational tone

   ## Performance Insights
   - [Date] "AI工具真香清单" got 1000 likes on XHS — list format + "真香" hook works
   ```

### 容量检查

If MEMORY.md exceeds 150 lines:
1. Identify entries that can be consolidated (similar learnings → one summary)
2. Move detailed case studies to `~/.autocrew/memory/archive-{date}.md`
3. Replace with a one-line summary in MEMORY.md

## 原则

- Be specific — actionable preferences, not vague observations
- Don't overwrite previous learnings, accumulate them
- Date every entry for tracking evolution
- Consolidate when file gets long, don't let it grow unbounded

## 错误处理

| 故障 | 处理 |
|------|------|
| MEMORY.md 不存在 | 创建初始结构 |
| 文件写入失败 | 记录错误，继续运行 |

## 变更日志

- 2026-03-31: v1 — Adapted from Qingmo memory-distill.md v3. Simplified to two-layer architecture (no LanceDB dependency). File-based storage only.
