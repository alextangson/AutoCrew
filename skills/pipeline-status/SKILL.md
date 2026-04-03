---
name: pipeline-status
description: |
  Show content pipeline status dashboard. Activate when user asks about project status, pipeline overview, content progress, or "看板".
triggers:
  - "项目进度"
  - "看板"
  - "管线状态"
  - "pipeline status"
  - "有什么在做"
invokable: true
---

# 内容管线看板

> Executor skill. Shows pipeline status across all stages.

## Steps

1. **Get status** — Call `autocrew_pipeline_ops` tool:
   ```json
   { "action": "status" }
   ```

2. **Display dashboard** — Format as:
   ```
   📋 内容管线看板

   📥 情报库    12 条（3 条今日新增）
   💡 选题池    8 个选题
   ✏️  创作中    2 个项目
     → AI编程-cursor对比
     → 职场效率-AI工具清单
   🎬 制作中    1 个项目
     → AI编程-agent模式体验
   📤 待发布    小红书(1) B站(1)
   ✅ 已发布    15 个项目
   🗑  回收站    3 个项目
   ```

3. **Offer actions** based on status:
   - If topics pool is low: "选题池快空了，要拉取新情报吗？"
   - If drafting has items: "要继续写 {project_name} 吗？"
   - If production has items: "有项目可以推进到待发布阶段"

## Error Handling

| Failure | Action |
|---------|--------|
| Pipeline not initialized | Call `autocrew init` first |
| Empty pipeline | Show empty dashboard, suggest starting with intel pull |
