---
name: calibrate
description: |
  读取并更新 AutoCrew 创作者档案。复用已有表达与样本，按用户明确意图校准，不强制采访。
  Trigger: 用户输入 "/calibrate" 或 "风格校准" 或 "校准风格"
---

# 风格与创作者档案校准入口

目的是把已经明确的定位、受众和表达偏好存进产品档案。无需固定轮数的采访，也不把校准作为写稿前必须完成的门。

1. 先 `autocrew_editorial {action:"profile"}` 读已有档案，结合当前对话判断哪些信息已经确定。用户只问查看就只读；要求微调就只改相关部分，不重做整份档案。
2. 依 `style-calibration` 比较实际样本的语气、节奏、结构和禁区。把用户原话与模型推断分开；只问真正影响结果又无法合理推断的信息。
3. 用户已明确要求保存或确认的信息，可直接 `autocrew_editorial {action:"update_profile", profile:{...}, user_confirmed:true}` 写入，无需重复确认。`profile` 支持 industry、expressionPersona、platforms、contentFormat、audiencePersona、styleBoundaries、voiceSamples；字段形状按实际工具 schema。
4. 仅当用户实际认可受众画像时，附 `confirm_audience:true`。模型拟出的画像不能自行标记已校准。只更新有依据的字段，不因空缺覆盖其他已有信息。
5. 读回档案，报告保存了哪些明确偏好、哪些仍是待验证假设。用户没有指定的风格不自动变成硬规则。

纯 MCP 通过结构化工具读写档案。不要用空初始化调用校准，不要求宿主编辑本地 profile / STYLE / MEMORY 文件，也不把展示一份风格摘要说成已持久保存。

用户继续写作时转 `spawn-writer`：`autocrew_workflow prepare → autocrew_scout 宿主调研与选角 → autocrew_writer pack → 宿主写作 → submit → autocrew_review_desk 宿主审稿`。档案更新后要重新领包，让新偏好真正进入本稿。
