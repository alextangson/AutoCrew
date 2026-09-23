---
name: spawn-batch-writer
description: |
  Orchestrate batch content writing from saved topics. Activate when user asks to write multiple posts at once. Trigger: "都写了" / "批量写" / "写30篇" / "把选题都写成文案".
---

# 批量写稿

把一批明确的写作任务逐篇推进。批量只改变数量，不降低材料、立意和交稿标准。

1. 从用户要求确定数量、选题范围、平台和共同要求；用 `autocrew_topic {action:"list"}` 读取现有选题，避免重复建题或把已有稿再写一遍。没有指定“全部”时，不默认把所有库存选题开写。
2. 每篇保存自己的完整 `requirements`，调用 `autocrew_workflow {action:"prepare", topic_id, platform, requirements}`。不要把上篇角度或平台口吻带到下一篇。
3. `researching` 按 next_action 到 `autocrew_scout` 由宿主完成取材、四视角、综合和立意，不等待后台模型；`needs_angle` 汇总待选候选、推荐理由与证据缺口，让创作者一次处理。已有明确方向用 `direction`，不重复问；用户未决定的题停在选角，继续其他已明确的题。
4. `ready_to_write` 后按 `write-script`：`autocrew_writer pack → pack_status → 宿主写作 → submit → autocrew_review_desk pack/submit → submit_status`。每篇有自己的材料包、编号和审稿结果；单宿主完成时标为 host_self_review，不能把分篇检查说成独立评审。默认 review=host，无需配置 engine。不要另外调用通用存稿工具保存生成稿。
5. 单篇失败保留失败原因与继续入口，不把失败当草稿完成。仅对本篇明确提供的材料声明 `research_mode=provided`；跳过调研必须有用户明确的 `research_reason`。
6. 逐篇报告实际状态：已保存、审稿通过或未审、仍需修改、等待角度或缺材料；末尾列稿件 id 与待处理项。采纳和发布由创作者决定。

共用选题不等于共用平台任务书；一稿多平台也按 `platform-rewrite` 为每个平台重新准备和交稿。
