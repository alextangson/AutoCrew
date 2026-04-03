---
name: manage-pipeline
description: |
  Create and manage automated content pipelines (scheduled workflows). Activate when user asks to set up automation, schedule content, create a pipeline, or configure cron jobs. Trigger: "自动化" / "定时" / "每天自动" / "设置 pipeline" / "内容排期".
---

# 自动化流水线

> 工具型技能。帮用户配置自动化内容工作流，支持预设模板和自定义排期。

## 可用模板

Use `autocrew_pipeline` action="templates" to list presets:

| Template | Name | Schedule | Steps |
|----------|------|----------|-------|
| `daily-research` | 每日选题调研 | 每天 9:00 | spawn-planner |
| `weekly-content` | 每周内容生产 | 每周一 10:00 | spawn-batch-writer |
| `daily-publish` | 每日定时发布 | 每天 18:00 | publish-content |
| `full-pipeline` | 全自动内容流水线 | 每周一 9:00 | spawn-planner → spawn-batch-writer → publish-content |

## 流程

1. Ask user what they want to automate:
   - "每天自动找选题" → `daily-research`
   - "每周自动写稿" → `weekly-content`
   - "每天定时发布" → `daily-publish`
   - "全自动" → `full-pipeline`
   - Custom → ask for schedule and steps

2. Create pipeline:
   ```json
   { "action": "create", "template": "daily-research" }
   ```
   Or custom:
   ```json
   { "action": "create", "name": "我的 pipeline", "schedule": "0 9 * * *", "description": "..." }
   ```

3. Explain to user:
   - **OpenClaw**: Pipeline will be registered as a cron job. Use `openclaw cron add` to activate.
   - **Claude Code**: Pipeline definition saved locally. User needs external cron (e.g. system crontab) to trigger.

4. Show next steps:
   <output_template lang="zh-CN">
   > Pipeline 已创建。
   > - OpenClaw 用户：运行 `openclaw cron add` 注册到 Gateway，会自动按计划执行。
   > - Claude Code 用户：可以手动运行，或配置系统 crontab 定时触发。
   </output_template>

## Cron 表达式速查

| Expression | Meaning |
|-----------|---------|
| `0 9 * * *` | 每天 9:00 |
| `0 9 * * 1` | 每周一 9:00 |
| `0 9,18 * * *` | 每天 9:00 和 18:00 |
| `0 */6 * * *` | 每 6 小时 |
| `0 9 1 * *` | 每月 1 号 9:00 |

## 变更日志

- 2026-03-31: v1 — New skill for AutoCrew. Pipeline templates + custom schedule support.
