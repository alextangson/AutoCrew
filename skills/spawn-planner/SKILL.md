---
name: spawn-planner
description: |
  Orchestrate a batch topic research session. Activate when user asks to plan content for a period, create a content calendar, or generate multiple topics at once. Trigger: "帮我找选题" / "调研一下" / "内容规划" / "这周写什么".
---

# Spawn Planner

> Orchestrator skill. Coordinates a research session to generate multiple topics. In OpenClaw, spawns a sub-agent. In Claude Code, executes inline.

## Inputs

| Parameter | Source | Required | Description |
|-----------|--------|----------|-------------|
| topic_count | User message (e.g. "想3个选题") | No | Number of topics requested (default: 3) |
| direction | User message (e.g. "围绕 AI 方向") | No | Specific topic direction or theme |
| user_requirements | Any additional constraints from user | No | Extra instructions |

## Steps

1. Extract inputs from user message.
   - IF user specifies a count (e.g. "想5个") THEN set `topic_count`.
   - IF user specifies a direction THEN set `direction`.
   - ELSE use defaults: `topic_count = 3`, `direction = auto`.

2. Notify user immediately:
   > 好，我去调研一下，给你找 {topic_count} 个选题，稍等几分钟。

3. Execute the research workflow (load `research` skill logic):

   a. Read `~/.autocrew/MEMORY.md` for brand context and competitor accounts.
   b. Use `web_search` to gather trending data for the user's industry.
   c. If competitor accounts are known, research their recent content.
   d. Generate `topic_count` topic ideas following the research skill's quality gates.

4. Save each topic using `autocrew_topic` tool:
   ```json
   { "action": "create", "title": "...", "description": "...", "tags": [...], "source": "..." }
   ```

5. Report results to user:
   ```
   调研完成，共找到 {count} 个选题：

   1. {title_1}
      {description_1}

   2. {title_2}
      {description_2}

   ...

   要选一个开始写吗？或者我继续调研其他方向。
   ```

## Guidelines

- Aim for a mix: competitor-inspired + trending + evergreen + seasonal
- Tag topics with priority (high/medium/low) in the tags array
- Include platform recommendations in each topic description
- Don't over-plan — match the user's stated capacity

## Error Handling

| Failure | Action |
|---------|--------|
| Web search fails | Use general knowledge. Note in description that no live data was available. |
| Topic save fails | Log error, continue with remaining topics. Report partial results. |

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo spawn-planner.md. Removed sessions_spawn dependency. Executes research inline instead of spawning sub-agent.
