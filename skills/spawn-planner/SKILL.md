---
name: spawn-planner
description: |
  Orchestrate a batch topic research session. Activate when user asks to plan content for a period, create a content calendar, or generate multiple topics at once. Trigger: "帮我找选题" / "调研一下" / "内容规划" / "这周写什么".
---

# 内容选题规划

按创作者的目标与产能安排一组值得写的选题；这一步产出选题计划，不自动承诺成稿或发布。

1. 读取已有选题和可用创作者档案，从用户话里整理周期、数量、平台、受众和完整要求。优先复用已有信息，不重复采访。
2. 按 `topic-ideas` 给出数量适当的候选，结合已有内容避免重复。把“已有事实支持”和“构思后待调研”分开，搜索未执行或失败就如实标注。
3. 每题说明主张/问题、适合的受众、为什么值得写、材料条件、建议平台与次序。推荐要有理由，不以一个分数代替判断。
4. 用户要求建立计划即用 `autocrew_topic` 建立或复用条目，将完整描述、出处、待查点保存；部分保存失败时报告哪几题没有成功。
5. 只对用户要推进的选题进入 `research` / `spawn-writer`。写作依次走 `autocrew_workflow prepare → 选角 → autocrew_writer pack → 宿主写作 → submit → submit_status`。等待角度的题可以汇总展示，不能默认代选。

不要把技能名称里的 spawn 理解为已经启动独立员工或后台任务；只有工具返回真实任务状态才可这么汇报。周期计划也不等于定时任务已运行，实际排期交给 `manage-pipeline` 检查执行器。
