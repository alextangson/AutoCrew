---
name: style-calibration
surfaces: gui, harness
gui_summary: 用户要校准风格或档案里没有风格规则时用——4 阶段问出并落库
description: |
  Calibrate writing style to match user's brand voice. Activate when user provides sample content, asks to set up their brand voice, or wants to calibrate style. Trigger: "风格校准" / "设置风格" / "我的风格是" / "参考这个账号".
---

# Style Calibration — 4 阶段品牌校准

> Conversational skill. 4 阶段对话流程：品牌调研 → 样本采集 → A/B 对比 → 写作人格生成。
> 结果写入 `~/.autocrew/STYLE.md` + 更新 `creator-profile.json`。

## Pre-read: Smart Context Loading

开始前静默读取（如果存在）：
1. `~/.autocrew/MEMORY.md` — 检查哪些信息已有
2. `~/.autocrew/STYLE.md` — 检查是否已有风格档案
3. `~/.autocrew/creator-profile.json` — 检查 `styleCalibrated` 状态

已有信息直接复用，不重复问。如果 `styleCalibrated: true`，告知用户已有风格档案，询问是否要重新校准。

## Phase 0: 品牌调研（2-4 轮对话）

> 目标：理解用户的品牌、目标、内容现状和风格边界。

**需要收集的信息**（跳过 MEMORY.md 中已有的）：

1. **定位与目标**：行业、变现模式、当前阶段（起步/成长/成熟）
2. **内容样本**：最好的已有内容（链接或文字），如果从零开始则描述想要的方向
3. **受众**：想触达的具体人群——一个具体的人，不是抽象的人口统计
4. **风格禁区**：绝对不想变成什么样

**对话风格**：每轮最多问 1-2 个问题。对用户的回答先给简短洞察，再问下一个。不要审讯式连问。

## Phase 1: 样本采集与分析（1-3 轮对话）

> 目标：从用户提供的内容样本中提取风格特征。

**如果用户提供了样本内容**，分析以下维度：
- 语气（随意/专业/活泼/权威）
- 句式结构模式（短句为主？长短交替？）
- Emoji 使用习惯（频率、位置、偏好的 emoji）
- 词汇水平和偏好表达
- 排版偏好（段落长度、分隔方式）
- Hook 模式（开头怎么抓人）
- CTA 模式（结尾怎么引导互动）

**如果用户没有样本**，提供 3 种风格模板让用户选择：
1. 知识分享型（干货密集、数据驱动、理性分析）
2. 故事叙事型（个人经历、情感共鸣、场景化）
3. 观点输出型（犀利观点、争议话题、强互动）

用户选择后，基于选择生成初始风格框架。

## Phase 2: A/B 对比验证（1-2 轮对话）

> 目标：用实际内容验证风格是否准确。

1. 选取用户提供的一个选题或从已有 topics 中取一个
2. 用 Phase 1 提取的风格写两个版本：
   - **版本 A**：严格按提取的风格
   - **版本 B**：在 A 基础上微调（更口语化 / 更专业 / 更短 / 更长）
3. 让用户选择更接近自己风格的版本，或指出需要调整的地方
4. 根据反馈微调风格参数

如果用户对两个版本都不满意，回到 Phase 1 重新采集。

## Phase 3: 写作人格生成与保存

> 目标：生成最终风格档案并持久化。
> **唯一机器事实源 = `creator-profile.json`（IA v4.2 §B2）**：引擎生成只读 writingRules/styleBoundaries，
> 不读 STYLE.md。先完成 3.1（结构化落库），STYLE.md（3.2）只是给人看的摘要，可选。

### 3.1 更新 `creator-profile.json`（主产出）

通过 `autocrew_init` 确保数据目录存在，然后更新以下字段：

- `industry` — 如果 Phase 0 中收集到了
- `platforms` — 如果 Phase 0 中收集到了
- `audiencePersona` — 从 Phase 0 的受众信息构建
- `styleBoundaries.never` — 从 Phase 0 的风格禁区
- `styleBoundaries.always` — 从风格分析中提取的必须保持的特征
- `writingRules` — 从 Phase 1/2 提取的具体写作规则，source 设为 `"auto_distilled"`，
  **scope 按 PRD-v4 §4.3 二分**：跨平台声音特征（用词癖好/口头禅/立场/禁忌）→ `"voice_core"`；
  某平台专属的形式规范（长度/结构/格式）→ `"platform:<平台id>"`（如 `platform:wechat_mp`）
- `styleCalibrated` — 设为 `true`

使用 `autocrew_memory` tool 的 `capture_feedback` action 记录校准事件。

### 3.2 生成 `~/.autocrew/STYLE.md`（可选的人类可读摘要，非机器事实源）

```markdown
# Brand Voice Profile

## Tone
[e.g., Casual-professional, like talking to a smart friend]

## Patterns
- Opening: [Hook 模式描述]
- Emoji: [使用频率、位置、偏好 emoji 列表]
- Paragraph: [段落长度偏好]
- Ending: [CTA 模式描述]

## Vocabulary
- Prefers: [用户偏好的词汇/表达]
- Avoids: [用户不喜欢的词汇/表达]

## Sentence Structure
- [句式特征描述]

## Platform Variations
- XHS: [小红书特定调整]
- WeChat: [公众号特定调整]
- Douyin: [抖音特定调整]

## Audience Persona
- Name: [主要受众人设]
- Profile: [一句话概括]
- Scroll-stop triggers: [什么让他们停下来]
```

### 3.3 追加 MEMORY.md

将品牌上下文追加到 `~/.autocrew/MEMORY.md`：
- 行业和定位
- 目标受众摘要
- 风格边界
- 竞品账号（如果提到了）

## Phase 4: 确认与试写

> 风格校准完成！我记住了你的品牌调性和目标受众。
> 以后写内容会自动参考这个风格。
> 要不要试一下？给我一个选题，我按这个风格写一篇看看。

## 关键原则

1. **风格档案要可执行** — 另一个写手拿到 STYLE.md 应该能直接用
2. **更新不覆盖** — 用户后续提供新样本时，更新而非替换
3. **STYLE.md 控制在 60 行以内** — 简洁可扫描
4. **A/B 对比是核心** — 不要跳过 Phase 2，这是校准准确度的关键
5. **写入 creator-profile.json** — 确保 `styleCalibrated: true`，其他 skill 依赖这个标记

## 工具依赖

- `autocrew_init`（确保数据目录存在）
- `autocrew_memory`（记录校准事件到 MEMORY.md）
- 文件系统读写（STYLE.md、creator-profile.json）

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo style-calibration.md v4. Removed SOUL.md dependency.
- 2026-04-01: v2 — 重构为 4 阶段流程（品牌调研 → 样本采集 → A/B 对比 → 写作人格生成）。新增 creator-profile.json 写入、A/B 对比验证、风格模板选择。

## GUI

**什么时候用**：用户说「风格校准」「设置一下我的风格」「我的风格是这样」「参考这个账号」，或你发现档案里根本没有风格规则。

### 方法论：4 阶段，一次只推进一层

**Phase 0 品牌调研**（2-4 轮）：定位与变现模式、内容样本、受众（一个具体的人，不是人口统计）、风格禁区（绝对不想变成什么样）。
对话纪律：每轮最多问 1-2 个问题，先对用户上一句给一句短洞察再问下一个，别审讯式连问。**上下文里已经有的（定位、平台席位、核心受众、目标）不要重复问。**

**Phase 1 样本采集**：从样本里提这几个维度——语气（随意/专业/活泼/权威）、句式（短句为主？长短交替？）、emoji（频率/位置/偏好）、词汇偏好、排版（段落长度、分隔方式）、hook 模式、CTA 模式。
用户没有样本 → 给三选一：知识分享型（干货密集、数据驱动）／故事叙事型（个人经历、场景化）／观点输出型（犀利、有争议、强互动），选完据此起初始框架。

**Phase 2 A/B 对比**（核心，别跳）：同一个选题出两版——A 严格按提取出的风格，B 在 A 上只微调一个变量（更口语／更专业／更短）。让用户选更像自己的那版，或指出要调哪儿。两版都不满意就回 Phase 1 重采样本。

**Phase 3 落库**：把敲定的东西写进创作者档案——GUI 面的唯一事实源。

**Phase 4 确认与试写**：告诉用户风格已记住、以后写稿自动参考，问要不要给个选题试写一篇。

### 步骤

1. 上下文里已有定位／受众／目标就直接复用，缺什么补什么（Phase 0）。
2. 用户粘了旧文案 → `absorb_style`（1-5 条样本）。贴的是链接 → 先 `read_url` 读正文，再把正文当样本。
   注意：用户粘一大段旧文时先问一句用途——是「学我的风格」还是「里面有想法要入灵感库」，别不问就默认其一。
3. 用户没样本 → 给三选一模板，选完把这个选择转成 1-2 条具体规则用 `add_style_rule` 记下来。
4. A/B 对比：优先拿用户已有的一篇稿做底（`list_drafts` → `get_draft`），用 `revise_draft` 出一个微调版让用户二选一；实在没有稿再 `generate_script` 起一篇（后台任务，投完引导用户去看板等它转正，别在对话里干等）。
5. 每敲定一条具体规则就 `add_style_rule` 一条（一条一句话，写成能直接照做的样子，别攒到最后一次性倒）。
6. 受众那部分走画像：`generate_persona` → 带用户逐层过 → `save_persona`。用户没明确认可绝不保存。聊出目标就 `set_goal`。
7. 收尾：告诉用户校准完成、规则已进档案，引导他去侧边栏「品牌校准」页复核，然后问要不要试写一篇。

### 边界

- GUI 面没有 `STYLE.md` / `MEMORY.md` 这类文件，**别提也别假装写过**。事实源是创作者档案——`add_style_rule` / `save_persona` / `set_goal` 写进去的那份。
- 更新不覆盖：用户后续再给新样本，是往上加规则，不是把之前的推翻。
- 规则要可执行——另一个写手照着这条规则能直接写出同款，才算数。
