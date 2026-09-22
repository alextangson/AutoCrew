---
name: topic-ideas
surfaces: gui, harness
gui_summary: 用户给模糊方向要选题时用——拆受众张力、出候选、入灵感库
description: |
  Interactive topic brainstorming from a seed idea. Activate when user gives a rough idea and wants to explore angles. Trigger: "帮我想" / "想选题" / "这个方向怎么样" / "灵感" / seed idea + "怎么做内容".
---

# 选题构思

把模糊想法变成值得写的方向。此时可以提出假设，但要与查证后的事实分开。

1. 从当前对话和 `autocrew_editorial {action:"profile"}` 获取创作者定位、目标受众与偏好。不要假设纯 MCP 会话已经注入完整档案，也不要要求读取本地配置文件。缺少信息时采用可说明的临时假设；只有缺项确实改变选题时才问。
2. 按用户种子、真实材料和目标提出候选，默认少量，数量服从用户要求。可从读者困惑、具体经历、判断分歧、实用问题中切入；不是所有题都必须反常识、追热点或制造焦虑。
3. 每条说明：题目、主要读者、核心主张或要回答的问题、为什么现在值得写、读完有什么收获、证据来源及待查部分。标题长度和开头形式服从目标平台，不套统一“20字/3秒”硬门。
4. 比较候选的独特性、证据条件与本次目标，推荐一个并说清取舍；不要把估计停留意愿说成真实受众测试或爆款概率。
5. 用户要求保存或已要求建立选题清单时，用 `autocrew_topic {action:"create", title, description, tags, source:"brainstorm"}` 落库，先查重。记录完整意图与待查点，不只存标题。
6. 用户要开始写时转 `spawn-writer`：`autocrew_workflow prepare → 选角 → autocrew_writer pack → 宿主写作 → submit`。需要真实材料时走 `research`，不能把构思当成已经调研。

本地工作台可能提供找热点、读链接等额外工具；只有工具实际可见时才使用。纯 MCP 只按已暴露能力执行，不调用工作台私有工具名。

## GUI

本节仅供 AutoCrew 工作台加载；纯 MCP 宿主执行上文。

结合上下文定位、画像与本次目标给出少量不同候选。可从经历、问题、分歧、实用知识切入；误区纠偏只是选项，标题与开头形式由内容和平台决定。

需要真实外部材料时，按可见工具使用 `find_topics`、`find_overseas_topics`、`scout_inspiration` 或 `read_url`。没有查到就标为待调研，不将想法说成事实。

每题解释给谁看、核心问题或主张、为什么值得写、材料与缺口；推荐有理由，最终保留用户选择。用户要求保存时 `save_topic`，避免重复。需要深调研时用 `deep_research` 并报告任务的真实状态；用户明确要写后再走工作台写作工具，不能跳过尚未决定的角度或隐瞒缺料。
