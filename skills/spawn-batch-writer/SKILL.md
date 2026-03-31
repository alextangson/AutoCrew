---
name: spawn-batch-writer
description: |
  Orchestrate batch content writing from saved topics. Activate when user asks to write multiple posts at once. Trigger: "都写了" / "批量写" / "写30篇" / "把选题都写成文案".
---

# Spawn Batch Writer

> Orchestrator for large writing orders. Iterates through saved topics and writes content for each.

## Inputs

| Parameter | Source | Required | Description |
|-----------|--------|----------|-------------|
| batch_count | User message (e.g. "写10篇") | No | Number of articles to write (default: all saved topics) |
| direction | User message | No | Theme / business direction filter |
| platform | User message | No | Target platform for all content |

## Steps

1. Extract `batch_count`, `direction`, and `platform` from user message.
   - If no count → will write for all unwritten topics.
   - If no platform → will infer per topic or ask user.

2. List existing topics using `autocrew_topic` action="list".
   - Filter by direction if specified.
   - Limit to `batch_count` if specified.
   - Skip topics that already have linked content.

3. Notify user:
   > 收到，我按 {count} 篇来写。会逐篇推进，每写完一篇会同步进度。

4. For each topic in the batch:
   a. Follow the `write-script` skill workflow.
   b. Save using `autocrew_content` tool with `topicId` linked.
   c. Report progress:
      > [{current}/{total}] 写完了「{title}」，已保存为草稿。

5. Final summary:
   ```
   批量写作完成：
   - 总计：{total} 篇
   - 已保存：{saved} 篇草稿
   - 平台分布：小红书 {xhs_count}，抖音 {dy_count}，...

   下一步：用 autocrew_content action=list 查看所有草稿，确认后可以标记为待发布。
   ```

## Guidelines

- Write each piece as a complete, publishable draft — don't rush for quantity.
- Match tone and format to the target platform.
- If a topic is too vague to write, skip it and note in the summary.
- Maintain variety — don't let all posts sound the same.

## Error Handling

| Failure | Action |
|---------|--------|
| No topics saved | Tell user to run research/spawn-planner first. |
| Write fails for one topic | Log error, continue with next topic. Report in summary. |
| All writes fail | Stop and report the issue. |

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo spawn-batch-writer.md. Removed backend batch job API. Executes sequentially inline.
