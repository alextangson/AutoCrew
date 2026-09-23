---
name: onboarding
description: 首次使用时读取已有档案，直接推进用户任务；已确认的偏好通过结构化接口保存。
---

# 渐进式了解创作者

用 `autocrew_editorial {action:"profile"}` 读取已有资料，结合当前对话直接推进用户请求。普通 MCP 调研、立意、写作和审稿由当前宿主完成，不要求配置 engine，也不把初始化问卷当作开工前提。

缺少定位或平台时先复用用户已给的信息；只有会实质改变结果且无法合理推断的缺项才问。临时推断须说清，不静默写成用户确认事实，不读取宿主 MEMORY 文件或直接修改 AutoCrew 业务文件。

用户要求校准时使用 `calibrate` / `style-calibration`；已明确确认的资料用 `autocrew_editorial update_profile`，带 `user_confirmed:true`，只有实际认可画像才 `confirm_audience:true`。不靠空初始化调用存档案。

用户要写作时按 `spawn-writer` / `write-script` 完成宿主调研、选角、材料包、写作与 `autocrew_review_desk` 审稿；根据真实回执说明材料、草稿和审稿状态。一次请求里推断出的偏好不自动升级为长期风格，真实反馈默认只影响本稿。
