# P1：立意阶段 + 证据按需回查进生产（实施 spec v1）

日期：2026-09-04 · 状态：待 codex 评审 · 上游：[angle-stage v3/v3.1](2026-08-23-angle-stage-and-ai-reviewer.md) §7（方法论）、[dsh 员工与案卷 v3](2026-09-02-dsh-employees-and-case-files.md)（架构，本刀不动案卷）· 实验：`experiments/p0-inputs-vs-structure/`

## 0. 为什么是这一刀

三轮实验（DeepSeek V4 Pro，中转整晚不通）的结论按创始人「会不会发」判：

| 轮 | 变量 | 可发 |
|---|---|---|
| P0 36 稿 | 调研量 × 流程 | 0/36；同选题 12 篇全「劝你别碰」——立场在调研综合里就定了 |
| P0b 6 稿 | + 独立立意 pass | 1/6 |
| P0c 6 稿 | + 定向补证 + 数字核验 + payoff + 无镜头标注 | **3/6**；18 条证据需求补回 16，31/31 数字有据 |

可发稿的共同点：主张是**机制判断**（纠正写在易失内存里 / 变化在 harness 层 / 起点从网址变成问题），第一手锚点是创作者**自己做插件的经历当转折点**。被否稿的共同点：主张靠比喻撑（选票箱、投票），或回到 Star 数劝退（带判断框架也否）。

所以 P1 第一刀 = 把立意阶段、定向补证、数字核验、三画像审稿放进生产。案卷制、dsh 员工子 agent 排在它后面：它们解决的是交接与恢复，不解决「稿子能不能发」。

## 1. 范围

**做**：
1. 立意 pass 从调研综合里拆出来，独立一步，产角度卡 v3。
2. 写稿前按选中卡的证据需求定向补证；写手带查证工具；`submit_script` 数字核验。
3. 审稿加第三类判据（三画像 + 误区 + 收获感）。
4. 口播赛道包去镜头标注；内部语料（创作者转写/审定稿）进立意与写手。
5. 角度卡 UI 与聊天回报显示新字段；存量简报可一键重跑立意。

**不做**：案卷目录、业务读取工具、租约锁/收据、dsh preset 员工、审稿超时治理、配额之外的调研架构改动。

## 2. 流程变化

现状：`deep-research` job = 四视角 → 综合（同一 pass 产 summary/tensions/evidence/**angleCards**）→ 落 brief vN。写稿：`resolveAngle` → 注入角度块 → 写手 → 审稿 → 修订。

P1：

```
四视角 → 综合（只产事实：summary/tensions/evidence/gaps；不再产 angleSuggestions/angleCards）
       → 内部语料检索（脚本）
       → 立意 pass（新）：误区清单 + 3–4 张卡 v3 + 代码打分 → 一起落 brief vN
写稿：resolveAngle（不变）→ 定向补证（新，按卡的 evidenceNeeds）→ 写手（新工具 find_evidence；submit_script 数字核验）
     → 审稿（新判据）→ 修订
```

立意 pass 在同一个 job 里、`saveBrief` 之前跑，所以 brief 仍不可变、所有 `angleCardsOf(brief)` 消费方不动。「只重跑立意」= 复制上一版研究字段 + 新卡落 v(N+1)（`saveBrief` 本就支持新 revision）。

## 3. 数据模型

### 3.1 AngleCard v3（`src/modules/research/brief-store.ts`）

`schemaVersion` 不 bump（沿用 2026-08-24 裁决：新字段全可选，旧简报逐字有效）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id / angle / thesis / coreEvidenceIds / tensionId? / antiScope / hookDraft` | 保留 | 同 v2 |
| `primaryPersona` | 是 | `grow \| trust \| convert` |
| `misconception` | 是 | 主画像走进来时信的错误认知（原话式） |
| `mechanism` | 是 | 一句话说清「为什么会这样」的因果——**没有机制的主张不是立意**（P0c 教训：比喻型被否） |
| `payoff` | 是 | 大白话为什么 + 一个观众今天能做的动作 |
| `personaGains` | 是 | 三画像各一句「看完会做什么」 |
| `elements` | 是 | 网感元素 ≥2，枚举 |
| `counterResponse` | 是 | 对反方一句话 |
| `firsthandAnchor?` | 否 | own-material 片段 id 或简报 `ev-N`；有则「亲历级」，无则「综述级」 |
| `evidenceNeeds` | 是 | 1–3 条，写稿前定向补证 |
| `structure` | 是 | `myth-busting \| story \| single-point \| claim-case-claim` |
| `nextAction` | 是 | 结尾最小动作 |
| `score` / `scoreReasons` | 代码写 | 代码侧打分，不是模型自评 |
| `audiencePain / holdTrigger` | 退役 | 读侧兼容：旧卡缺新字段时按 v2 渲染 |

`parseAngleCard`（创始人改写卡）：允许改所有文字字段，仍禁改 `id` 与 `coreEvidenceIds`。

### 3.2 内部语料（新 `src/modules/research/own-material.ts`，从 `experiments/.../lib/internal-corpus.ts` 搬）

- 来源：`contents/*/video/transcript.v*.json`、人审放行稿（approved/publish_ready/publishing/published）；排除同选题 AI 稿；非本选题转写最多 1 段；每段 ≤4500 字、总量 ≤8000。
- 结果不落盘（可重算），随 job 进立意 pass 与写手研究槽；`Content.usedOwnMaterial: {contentId, kind}[]` 记归因。
- 注入规则（写进写手提示）：**转写可作「我亲身经历的转折」，不可作「讲解另一个主题」**；第一手材料只用卡上 `firsthandAnchor` 指定的那一处，其余只供口吻参考。

### 3.3 定向补证结果

不进 brief（brief 不可变、补证发生在写稿时）。落 `Content.targetedEvidence: TargetedLookup[]`（need / items{ id, claim, quote, sourceId, sourceUrl } / gaps / status），run-log 同步记录。id 前缀 `ev-T`，与简报 `ev-N` 区分。

### 3.4 三画像

`CreatorProfile.audiencePersona` 现有 core/adjacent/surprise 三层（老周/苏晴/阿杰）全是变现画像。P1 **不改画像存储**；立意 pass 的三画像（涨粉/立信/变现）由代码从 profile 派生：`convert` = core 画像原文；`trust` = 固定「同行/独立开发者」模板 + `profile.industry`；`grow` = 固定「被 AI 追着跑的职场人」模板 + industry。三段模板文本放 `src/modules/research/personas.ts`，是**唯一规则本**；画像库升级（让创始人在设置里改三画像）列 P2。

## 4. 模块改动

### 4.1 立意 pass（新 `src/modules/research/angle-stage.ts`）

- 输入：brief 事实字段 + own-material + 三画像 + 选题。输出经 `submit_angles` 工具校验（形状 + 判据：元素 ≥2 且不全是新奇点、三画像收益齐、misconception/mechanism/payoff/nextAction/counterResponse 非空、evidenceNeeds 1–3、thesis 互不重复、`coreEvidenceIds` 存在性、身份自嘲词表拒绝）。
- 打分（代码）：元素数（≤3）+ 有 `firsthandAnchor` +2 + `mechanism` 引用了 `ev-N`/own-material id +1 + 主画像 grow +1；**劝退词表 −3**（不再给「带判断框架」豁免）；比喻型不靠正则判，靠 `mechanism` 必填。
- 路由：`scout` 路由（同调研）；`maxTurns 5`、`60k` token；修复轮 ≤2；失败 → brief 无卡 + `gaps` 记「立意未产出」（同 v2 §1.8 纪律，不逼模型编）。
- `research-synthesis.ts`：删 `angle_cards` / `angleSuggestions` 产出与校验（`readAngleCards` 改由立意 pass 调用）；prompt 相应删「角度」段。
- 差异性校验沿用 `checkDistinct`。

### 4.2 定向补证（新 `src/modules/research/targeted-research.ts`，从 harness 搬）

- `createTargetedResearcher({dataDir, config, runLoopImpl?})`，同 `createResearchBroker`（同注入定界、同 `validateQuote`/`locateQuote`）；每需求一条短循环（`search`/`read_page`/`submit_evidence`，`maxTurns 8`，`15k`）；配额独立于四视角：`searchPerPerspective 5 / readPage 8 / job 40 / 60`。
- 写稿时调用点：`generate-script.ts` `gatherInputs` 之后、`buildScriptPrompts` 之前，对生效角度卡的 `evidenceNeeds` 逐条补证，渲染 `<<<TARGETED_EVIDENCE>>>` 块追加进研究槽（研究槽预算：补证块**不受** `RESEARCH_SLOT_BUDGET` 裁剪，它是为这稿专门找的；简报块预算不变——案卷制再退役上限）。
- 手写 `direction`（无卡）时不补证；`skip_reason` 直写时不补证。
- 时间：每需求 ≤3 分钟墙钟，超时按 `empty` 处理并 warn；三条并行。

### 4.3 写手

- `runWriterLoop` 工具箱加 `find_evidence(need)`（≤3 次，只回校验过的引文）；修订轮同。
- `validateSubmitArgs` 新增**数字核验**：正文所有数字（含中文数字词「九万五千」先转阿拉伯）必须出现在证据语料（简报 evidence quotes + 补证 + own-material + 用户 research 字段 + 选题描述）中；未命中 → 返回 `Error` 列出数字并要求「删除、改为材料里的数、或标 [未证实]」；修复轮计入现有 `gate.maxRepairRounds`。标「[未证实]」的数字放行但记 `Content.unverifiedNumbers`。
- 角度块渲染（`buildAngleBlock`）升级为 v3 字段：主画像/误区/机制/主张/动作/三画像收益/元素/反方/锚点/骨架/收获感 + 三条硬规则（前 3 秒误区提问；一稿一主张；结尾最小动作）+ 术语翻译 + 证据纪律 + 自嘲边界 + 转写用法。`ANGLE_FIELD_MAX` 200 字上限对 `mechanism/payoff` 放宽到 400。
- 口播赛道包（`koubo.ts`）：`platformAdjustments.douyin.style` 改为「纯口播正文，不写画面/字幕条/镜头标注；3 秒内出钩子」；质量门加检查：正文含 `[画面]`/`[字幕条]`/`[切` → gate 失败。`~/.autocrew/STYLE.md`「视频化标注」一节由 `init` 模板改（存量文件不动，它不进提示词）。

### 4.4 审稿（`script-review-prompt.ts`）

第三类判据「立意执行」，仅在有角度卡时启用：
- 主画像动作没达成（审稿以该画像身份读完答不出「我会做什么」）→ blocker
- 误区没在前 3 秒点出、或正文没反驳 → blocker
- `payoff` 没兑现（没有大白话的为什么 + 动作）→ blocker
- 主张不可反驳（复述材料）→ blocker
- 元素命中 <2、结尾无最小动作、含 `[未证实]` → advisory
现有「不要凭空要求补数据」一条改为：数字无据可要求补——但只在 `find_evidence` 可用的修订轮。

### 4.5 UI 与聊天

- `AngleCards.tsx` / `chat/cards.tsx`：显示 `primaryPersona`、`misconception`、`payoff`、`evidenceNeeds`、`score`；旧卡缺字段隐藏行。
- `chat-router.ts` `needsAngleReply`：每卡一句改为「主画像 · 主张 · 收获」；规则 27 不变（不替用户选）。
- 新 IPC / chat 工具 `regenerate_angles(topicId)`：对最新 brief 重跑立意 pass → 新 revision；用于存量 9 份无卡简报与「这几张都不行」。
- `ResearchPanel` 增「补证结果」折叠区（读 `Content.targetedEvidence`）。

### 4.6 调研上游（小）

- `research-perspectives.ts`：`invalid_output` 只剔不合格的那几条 insight/evidence，剩余 ≥1 条即 `succeeded`（`partial: true` 标记进 output）；全空才 failed。
- 受众视角 insight 允许 `kind: "inference"`（无 sourceIds），综合与立意读到时知道是推断。

## 5. 边界行为

| 情形 | 行为 |
|---|---|
| 简报无 evidence | 立意 pass 仍跑（可出综述级卡，`firsthandAnchor` 空），不再整体跳过；卡标「综述级」 |
| 立意 pass 失败/超时 | brief 无卡 + gaps 记录；写稿走现有「无卡」路径；UI 可点重跑 |
| 补证全空 | 写手收到「没有证据，不要编」块；`Content.targetedEvidence` 记 empty；审稿对该主张的数字要求放宽为「如实说没有数据」 |
| 补证超时/搜索 key 未配 | warn + 跳过补证，稿件版本注记「未补证」；`find_evidence` 工具仍挂但返回「搜索未配置」 |
| 数字核验误杀（年份、序号、版本号） | 白名单：4 位年份、`v1.2` 形式版本号、≤2 位序号、时间「3 秒」类单位词后缀数字不算；其余一律要证据 |
| 中文数字 | 「九万五千」「三成」转数值后比对；转换失败按未核验处理并列出 |
| 创始人改写卡后 `mechanism` 空 | `parseAngleCard` 拒绝并提示 |
| 存量简报无卡 | `regenerate_angles` 新 revision；旧 revision 不动 |
| 手写 direction | 不补证、不做角度块 v3；数字核验仍生效 |
| 修订轮 | 同一 `find_evidence` 预算（3 次/稿）跨写手与修订共享 |
| DeepSeek 审稿 300s 超时 | 本刀不治（记 P2），降级路径不变 |

## 6. 测试与验收

- 单测：`angle-stage`（校验 12 条、打分表、劝退扣分、身份自嘲拒绝）、`targeted-research`（引文纠正归属、空结果、超时）、`validateSubmitArgs` 数字核验（白名单、中文数字、修复轮）、`own-material`（同选题排除、转写上限）、`koubo` 镜头标注 gate、审稿判据渲染开关、`readAngleCards` 从综合迁出后综合 prompt 无「角度」字样。
- 真 LLM 冒烟：三个 P0 选题走生产路径（`deep_research` → `regenerate_angles` → `generate_script`），产物与 P0c 同盲评格式给创始人；验收线 **可发 ≥3/6**，且 unverifiedNumbers 全稿 0。
- 全仓测试绿；`npm run build`。

## 7. 分期与顺序

| 期 | 内容 | 依赖 |
|---|---|---|
| P1a | 3.1 卡 v3、4.1 立意 pass、3.4 画像派生、4.5 UI/regenerate、综合去角度 | 无 |
| P1b | 3.2 own-material、4.2 补证、4.3 写手（工具 + 数字核验 + 角度块 v3 + 赛道包） | P1a（卡字段） |
| P1c | 4.4 审稿、4.6 调研上游 | P1b |

每期独立可发布；P1a 落地后存量简报即可重跑立意看卡。

## 8. 待创始人裁决

1. 数字核验拒绝时默认动作：打回让写手改（严），还是自动加「[未证实]」放行 + 审稿 advisory（松）？倾向严——P0c 证明打回后写手能补。
2. 三画像固定模板放代码里（P1）还是现在就进设置页（多一周）？倾向 P1 代码里，P2 进设置。
