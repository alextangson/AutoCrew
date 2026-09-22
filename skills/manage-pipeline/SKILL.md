---
name: manage-pipeline
description: |
  Create and manage automated content pipelines (scheduled workflows). Activate when user asks to set up automation, schedule content, create a pipeline, or configure cron jobs. Trigger: "自动化" / "定时" / "每天自动" / "设置 pipeline" / "内容排期".
---

# 内容自动化管理

把用户明确要求的周期工作保存为任务定义，并核实谁实际执行。保存定义不等于到点会运行。

1. 先确认当前宿主真实可见的能力。dsh 默认没有流水线管理工具；不要假装已经在那里创建定时任务。
2. 有 `autocrew_pipeline` 时，先 `action:"list"` 查已有定义，`action:"templates"` 查当前模板，避免重复创建。按用户提供的周期、范围与时区准备定义；不要凭空假定发布账号、内容、数量或时间。
3. 用 `action:"create"` 和实际 schema 支持的参数保存，或对已有任务 `enable` / `disable`。工具仅保存本地定义；必须另有可核实的执行器与运行记录，才能说“已自动执行”。
4. 执行器须沿用相同写作契约：`autocrew_workflow prepare → 选角 → autocrew_writer pack → 宿主写作 → submit → submit_status`。没有宿主在场时，后台写作必须是用户明确选择的 `execution=engine`。未选角的任务等待用户，不能默选第一张；研究失败、待审或有问题的稿件不能当完成品。
5. 若当前宿主没有调度执行能力，清楚区分“定义已保存”和“尚未启用执行”，给出准确剩余步骤；不要自行添加系统 cron 或宣称 OpenClaw Gateway 已注册。
6. 发布授权与写稿排期分开。用户要求定期写稿不等于授权发布；发布仍走作者认可与发布前检查。最终报告定义、执行器状态、最后实际运行与待处理项。

在 Codex 等自带调度的宿主中，使用该宿主提供的自动化工具管理定时运行，不用本地定义冒充宿主任务。
