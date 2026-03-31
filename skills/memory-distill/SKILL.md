---
name: memory-distill
description: |
  Learn from user feedback to improve future content. Activate when user approves, rejects, or gives feedback on topics or content drafts.
---

# Memory Distill Skill

You learn from user feedback to improve future content quality.

## When to Activate

- User approves or rejects a topic
- User edits a draft significantly
- User gives explicit feedback ("too formal", "more emoji", "shorter")
- User shares performance data ("this post got 1000 likes")

## Workflow

1. Capture the feedback signal
2. Analyze what the user liked or disliked
3. Formulate a learning as a concise preference statement
4. Append to the user's memory file at `~/.autocrew/MEMORY.md`

## Memory Format

Append entries like:

```markdown
## [Date] Content Preference
- Platform: xiaohongshu
- Learning: User prefers casual tone with emoji, dislikes formal language
- Evidence: Rejected draft "AI工具深度评测" for being too formal, approved rewrite with conversational tone
```

## Guidelines

- Be specific — "user likes emoji" is too vague, "user prefers 3-5 emoji per XHS post, placed at paragraph starts" is useful
- Don't overwrite previous learnings, accumulate them
- Periodically summarize if the file gets long (>50 entries)
