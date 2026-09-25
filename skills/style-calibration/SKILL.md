---
name: style-calibration
surfaces: gui, harness
gui_summary: 用户要校准风格时用——复用已有样本，确认适用范围后结构化保存
description: |
  Calibrate writing style to match user's brand voice. Activate when user provides sample content, asks to set up their brand voice, or wants to calibrate style. Trigger: "风格校准" / "设置风格" / "我的风格是" / "参考这个账号".
---

# 用样本校准表达

让模型用具体证据理解“像你”是什么意思。复用用户已经提供的作品、修改与要求，不要求从头再填一遍问卷。

## 读取与分析

用 `autocrew_editorial {action:"profile"}` 读档案。分析现有样本的叙述视角、措辞、论证方式、句子节奏、段落形式、开头和收束习惯；CTA、emoji、短句或反常识开头都不是默认要求。样本只有一篇时，不把该篇的偶然写法升级成永久风格。

先指出两三条有具体例子的观察。需要验证时可在对话里给短段落对照，解释差异，沿用用户选择；不为完成固定流程生成两篇完整稿。若用户要求正式成稿，走 `write-script` 的完整提交链。

## 保存

用户已明确确认的定位、画像、声音样本与风格边界，用：

```json
{ "action":"update_profile", "profile":{"expressionPersona":"用户已确认的表达方式"}, "user_confirmed":true }
```

调用 `autocrew_editorial`，`profile` 填实际确认的非空字段：industry / expressionPersona / platforms / contentFormat / audiencePersona / styleBoundaries / voiceSamples，按工具 schema 组织。示例字段值要替换为用户已经确认的实际内容。只有用户认可画像时才附 `confirm_audience:true`；不伪造确认时间或身份事实。

针对已有稿件的修改偏好，按 `memory-distill` 调 `autocrew_editorial feedback`：默认只作用本篇；用户说“这个平台以后都这样”才 `scope=platform`，明确跨平台长期表达才 `scope=voice`。没有稿件时，已确认的稳定边界可通过 `update_profile` 保存；不要为了写规则创建假稿件。

返回后读回核对。普通 MCP 由当前宿主分析样本，通过 editorial 保存已确认字段，无需后台模型。`autocrew_style absorb_samples` / `distill` 默认返回 `host_style_task`，提供原始样本、修改差异与已有档案，由你分析；只有明确选择 `execution=engine` 才运行后台蒸馏。工具返回材料不是用户确认或档案更新的替代品；模型提炼规则不得覆盖本次明确要求。

## 完成标准

说明实际保存的字段与适用范围，以及下一稿怎么使用。档案变化后重新 `autocrew_writer pack`；旧包不会因为聊天里说过新偏好就自动更新。纯 MCP 不调用 GUI 私有画像函数，不直接编辑本地档案文件，也不靠初始化调用写入校准。

## GUI

本节仅供 AutoCrew 工作台加载；纯 MCP 宿主执行上文。

复用上下文已有定位、画像、目标与样本；只问会改变结果的缺项，不固定跑四轮访谈。按具体样本解释表达习惯，用户没确认的观察不存成硬规则。

用户明确的长期偏好用 `add_style_rule`；单篇修改直接进入本稿改稿要求，不扩大为全平台规则。受众需要更新时可用 `generate_persona` 提案，用户认可后 `save_persona` 保存；已有明确画像不重复生成。用户明确目标用 `set_goal`。

以工具实际返回为保存依据。没有可写字段的资料只在当前对话使用并说明未保存；不要声称编辑过本地档案文件，也不假装当前未暴露的 MCP 工具已经调用。
