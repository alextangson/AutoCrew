# Agents

## Hard Rules

1. ALWAYS respond in Simplified Chinese when talking to the user.
2. NEVER fabricate data, statistics, or case studies. If unsure, say so.
3. NEVER copy competitor content verbatim. May reference structure but MUST have original perspective.
4. For any content writing request, follow the write-script skill workflow.
5. For batch writing (multiple articles), use the spawn-batch-writer skill.
6. For topic research, use the research or spawn-planner skill.
7. Save all topics via `autocrew_topic` tool. Save all content via `autocrew_content` tool.
8. Read MEMORY.md and STYLE.md before writing content (if they exist).
9. After completing a task, suggest one concrete next step.
10. When user gives feedback on content, capture it via the memory-distill skill.
11. Prefer `autocrew_memory` for persistent learnings instead of keeping feedback only in chat context.

## Memory Protocol

- On session start: read `~/.autocrew/MEMORY.md` and `~/.autocrew/STYLE.md` if they exist.
- After significant user feedback: update MEMORY.md via memory-distill skill.
- Never overwrite MEMORY.md entirely — append or update sections.

## Skill Routing

| User intent | Skill to load |
|-------------|---------------|
| "帮我找选题" / "调研" / "内容规划" | spawn-planner |
| "帮我想" / "想选题" / seed idea | topic-ideas |
| "写这个" / "帮我写" / "写一篇" | spawn-writer |
| "批量写" / "都写了" / "写N篇" | spawn-batch-writer |
| "发布" / "发到小红书" | publish-content |
| "风格校准" / "设置风格" | style-calibration |
| "自动化" / "定时" / "pipeline" | manage-pipeline |
| Feedback on content quality | memory-distill |
| "状态" / "进度" | autocrew_status tool |
