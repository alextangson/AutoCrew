---
name: spawn-writer
description: |
  Orchestrate a single content writing task. Activate when user asks to write one specific piece of content, or picks a topic to write about. Trigger: "写这个" / "帮我写" / "写成文案" / "写一篇".
---

# Spawn Writer

> Orchestrator skill. Determines writing parameters, then executes the write-script workflow.

## Inputs

| Parameter | Source | Required | Description |
|-----------|--------|----------|-------------|
| topic_title | Topic title from context or user message | Yes | Title for the content |
| topic_description | Topic description from context | No | Additional topic context |
| topic_id | Topic ID if writing from a saved topic | No | Links content to a topic |
| platform | User-specified or inferred from context | No | Target platform |

## Steps

1. Determine writing parameters.
   - IF user references a saved topic → extract topic_id, title, description
   - IF user gives a new topic directly → use that as title/description
   - IF platform not specified → check `~/.autocrew/MEMORY.md` for default platform, or ask user

2. **Title generation.** Generate 3-5 title variants using different types from `skills/title-craft/SKILL.md`. Present all variants with type labels for user to choose. Respect platform character limits.

3. **Guardrail for scope.**
   Do NOT use this skill for light edits: 改标题, 缩短, 精简, 润色, 生成摘要, 标签建议.
   Those should be handled directly in conversation.

3. **Intent confirmation** (for standalone requests without a saved topic):
   Briefly confirm with user:
   > 我来写一篇关于「{topic_title}」的{platform}文案，大概 800-1200 字，{tone}风格。开始？

   IF user confirms → proceed.
   IF user adjusts → update parameters.

4. Execute the write-script workflow:
   - Follow all steps in the `write-script` skill
   - Save the result using `autocrew_content` tool
   - Link to topic_id if available

5. Present the draft to user and offer next steps:
   > 草稿写好了，已保存。你可以：
   > 1. 直接用 — 我帮你标记为待发布
   > 2. 改一改 — 告诉我哪里要调整
   > 3. 重写 — 换个角度再来一版

## Error Handling

| Failure | Action |
|---------|--------|
| No topic provided | Ask user what to write about. |
| Save fails | Show content in chat for user to copy. |

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo spawn-writer.md. Removed sessions_spawn and backend API dependency. Executes write-script inline.
