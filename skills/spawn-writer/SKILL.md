---
name: spawn-writer
description: |
  Orchestrate a single content writing task. Activate when user asks to write one specific piece of content, or picks a topic to write about. Trigger: "写这个" / "帮我写" / "写成文案" / "写一篇".
---

# 起一篇稿

当前宿主承担总编辑、研究、写作与审稿职责；这些是阶段分工，不默认代表独立 agent 已启动。先落实创作者本次规划，再让工具保存证据和交接结果。

1. 复用或建立 `autocrew_topic` 选题。沿用已明确的平台、受众、目标、提纲、必写/禁写、篇幅、口吻及反馈，完整放进 `requirements`；事实与出处放 `research`，明确主张才放 `direction`。不重复采访已有信息。
2. 调 `autocrew_workflow {action:"prepare", topic_id, platform, requirements}`。它默认交给宿主研究，按 `next_action` 到 `autocrew_scout` 领取并完成研究任务；收到 `researching` 不能空等后台模型。按 `research` 技能由你读来源、交四视角、综合和候选立意。普通 MCP 流程不要求配置 engine。
3. 说明实际查到了什么、仍缺什么，再展示候选的不同主张、证据与推荐理由。不只展示第一张；建议不代替用户选择。已有明确 `direction` 时沿用，不重复选卡。
4. 用户选择后用 `autocrew_workflow {action:"select_angle", topic_id, angle_id, brief_revision}` 保存；修改卡面时按 schema 传完整 `card`。回 `prepare`，`ready_to_write` 后按 `next_action` 领 `autocrew_writer pack`。
5. 转 `write-script` 执行：完整要求进入包，宿主写作，`submit` 默认 `review=host`，再用 `autocrew_review_desk pack/submit` 完成宿主审稿，最后 `submit_status` 核对状态。不能把稿子已保存说成已经审完。

用户提供足够材料时可用 `research_mode:"provided"` + `research`；用户明确不需要研究时用 `research_mode:"skip"` + `research_reason` 原话。材料和立意分别说明，不能为绕过故障自行跳过。补充资料可用宿主可用搜索或 `autocrew_scout read_page` 直接抓网址；第三方搜索未配置不等于必须配后台模型。

轻改标题、摘要或口吻可先在对话给修改建议；要更新正式稿件时仍走原 `content_id` 的写作包和提交链。等待用户选角、关键事实确实缺失、任务失败或认领冲突时说明具体原因与下一步，不编造结果、不无限重试。

交付解释材料来源、采用角度、由谁写及审、真实质量状态和剩余问题。单宿主自审必须如实说是 `host_self_review`，不宣称独立审稿或用户已认可。只有用户明确选择 `execution=engine` 或已授权的无人值守后台任务才进入后台模型路径；第三方搜索、图像和视频的额度独立。
