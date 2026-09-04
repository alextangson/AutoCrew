# P1：立意阶段 + 证据按需回查进生产（实施 spec v2）

日期：2026-09-04 · 状态：v2，已吸收 codex 评审 28 条（25 P1，处置表 §10）· 上游：[angle-stage v3/v3.1](2026-08-23-angle-stage-and-ai-reviewer.md) §7（方法论）、[dsh 员工与案卷 v3](2026-09-02-dsh-employees-and-case-files.md)（架构，本刀不动案卷）· 实验：`experiments/p0-inputs-vs-structure/` · codex 会话 `.context/codex-session-id`

## 0. 为什么是这一刀

三轮实验（DeepSeek V4 Pro，中转整晚不通）按创始人「会不会发」判：

| 轮 | 变量 | 可发 |
|---|---|---|
| P0 36 稿 | 调研量 × 流程 | 0/36；同选题 12 篇全「劝你别碰」——立场在调研综合里就定了 |
| P0b 6 稿 | + 独立立意 pass | 1/6 |
| P0c 6 稿 | + 定向补证 + 数字核验 + payoff + 无镜头标注 | **3/6**；18 条证据需求补回 16 |

可发稿共同点：主张是**机制判断**（纠正写在易失内存里 / 变化在 harness 层 / 起点从网址变成问题），第一手锚点是创作者**自己做插件的经历当转折点**。被否稿共同点：靠比喻撑（选票箱、投票），或回到 Star 数劝退（带判断框架也否）。

**实验数据的诚实说明**：P0c 的「31/31 数字有据」是字符串级匹配（`5` 能命中 `15`，`30%` 能配上 `30 元`），只证明「没有凭空出现的数字串」，不证明同主张同单位。生产版数字核验按 §4.4 重做。实验的补证配额配置字段名写错（`search/readPage` 不是 broker 的 `searchPerPerspective/...`），实际跑的是默认 4/6/14/20——所以 16/18 是在默认配额下达成的。

## 1. 范围

**做**：立意 pass 独立；角度卡 v3；写稿前定向补证；写手查证工具；数字硬门；口播格式硬门；审稿第三类判据；内部语料进立意与写手；单一简报快照；angle-only 重跑作为研究 job；UI 与聊天显示新字段。

**不做**：案卷目录、业务读取工具、租约锁通用化、dsh preset 员工、审稿超时治理、三画像设置页（P2）、`STYLE.md` 改动（它不进提示词，init 模板也没有「视频化标注」一节——空操作，删）。

## 2. 流程

```
研究 job（kind=full）：四视角 → 综合（只产事实；angleSuggestions 写 []）→ 内部语料检索（脚本）
                        → 立意 pass → 卡 v3 + 代码分 → 落 brief vN → CAS 推进 job.briefRevision
研究 job（kind=angles）：读当前指针的 brief → 内部语料 → 立意 pass → 复制事实字段 + 新卡落 v(N+1) → CAS 推进指针
写稿：resolveEffectiveBrief（唯一入口，§3.0）→ resolveAngle（不变：direction > 选中卡 > 无）
     → 定向补证（按卡 evidenceNeeds，独立墙钟）→ 输入预算装配（§4.3）→ 写手（find_evidence，共享账本）
     → submit_script：形状 → 口播格式硬门 → 数字硬门 → 质量门 → 审稿（第三类判据）→ 修订（同账本同工具）
```

## 3. 数据模型

### 3.0 单一简报快照（codex #4/#5）

现状有两套「最新简报」：研究注入认 `job.briefRevision`（`generate-script.ts:188`），角度解析/选卡 IPC/聊天闸口认磁盘最大 revision（`generate-script.ts:244`、`ipc.ts:1552`、`chat-router.ts:558`）。会把 brief v1 与 angle v2 拼进同一稿。

新增 `resolveEffectiveBrief(topicId, dataDir): Promise<BriefSnapshot | null>`，`BriefSnapshot = { brief, revision, hash }`，**只认 `job.briefRevision`**；`loadLatestBrief` 退出所有有效态判断（只留给 UI 列历史版本）。一次生成只读一次快照，注入、选卡校验、补证、归因、审稿全部复用同一对象。`SelectedAngle` 校验改为对快照 revision。

### 3.1 AngleCard v3（`brief-store.ts`）

落盘类型 `AngleCard = AngleCardV2 | AngleCardV3`，判别字段 `cardVersion: 3`（v2 卡无此字段）。新产地只产 v3；读侧两版都认；UI 两版都渲染。`ResearchBrief.schemaVersion` 不 bump（新卡是可选字段的联合，旧简报逐字有效）。

| 字段 | 说明 |
|---|---|
| `cardVersion: 3` | 判别 |
| `id / angle / thesis / tensionId? / antiScope / hookDraft` | 同 v2 |
| `evidenceLevel: "grounded" \| "overview"` | grounded 要求 `coreEvidenceIds ≥1`；overview 允许空但 `evidenceNeeds` 必填且 ≥2 |
| `coreEvidenceIds` | grounded 必填 |
| `primaryPersona: "grow" \| "trust" \| "convert"` | |
| `misconception / mechanism / payoff / nextAction / counterResponse` | 必填文本；`mechanism`、`payoff` 上限 400 字，其余 200 |
| `personaGains: {grow, trust, convert}` | 必填 |
| `elements[]` | 枚举，≥2，不全为「新奇点」 |
| `firsthandAnchor?` | **结构化引用** `{ kind: "transcript" \| "approved_draft" \| "brief_evidence", contentId?, sourceRevision?, chunkId?, excerptHash, quote }`；提交时校验引用存在且 `quote` 在该片段/证据里逐字存在 |
| `evidenceNeeds[]` | 1–3 |
| `structure` | 枚举 |
| `score / scoreReasons` | 代码写，**只用于展示与排序**；永不写 `selectedAngle`；客户端提交的 score 字段一律丢弃，服务端重算 |

`parseAngleCard`（创始人改写）：可改所有文本；禁改 `id / coreEvidenceIds / cardVersion / firsthandAnchor.excerptHash`；改后服务端重算 score。

### 3.2 内部语料（新 `src/modules/research/own-material.ts`）

- 来源：`contents/*/video/transcript.v*.json`（**版本号数值排序**取最新）、人审放行稿；排除同选题 AI 稿；非本选题转写最多 1 段；每段 ≤4500、总 ≤8000。
- 片段有稳定 id：`om:<contentId>:<kind>:<sourceRevision>:<chunkIndex>` + `excerptHash`（片段文本 sha256 前 16）。
- 渲染经 `externalBlock` + `sanitizeExternal`（片段级与块级上限），不能伪造结束定界。
- 归因分两处：`brief.ownMaterialRefs[]`（立意 pass 实际读到的片段 id + hash）与 `Content.usedOwnMaterial[]`（写手实际注入的片段 id + hash）。
- 注入规则：转写可作「我亲身经历的转折」，不可作「讲解另一个主题」；第一手材料只用卡上 `firsthandAnchor`，其余只供口吻参考。

### 3.3 证据账本（每稿一份，`EvidenceLedger`）

- 条目 `{ id, source: "verified_quote" \| "user_claim" \| "own_claim", claim?, quote, sourceId?, sourceUrl?, need? }`。
- `verified_quote`：简报 `ev-N`、补证 `ev-T<need>.<i>`、写手查证；`own_claim`：own-material 片段；`user_claim`：`req.research` 与选题描述。**只有 `verified_quote` 算「外部已核验」**。
- `LookupBudget`：每稿 `find_evidence` 3 次，写手与修订**共享同一实例**。
- 落盘：`Content.evidenceLedger`（含补证 lookups 的 status/gaps）；写手启动前先随占位稿落一次，生成失败也不丢。

### 3.4 三画像（`src/modules/research/personas.ts`）

三段**带版本**的默认模板（`personasVersion: 1`）：涨粉/立信/变现。`profile.industry` 拼进模板；现有 `audiencePersona.core/adjacent/surprise` **只作补充上下文**，不映射为 convert（代码只保证它是「核心受众」，无变现语义）。设置页可改三画像 = P2，届时加 `profile.personaRoles`。

### 3.5 研究 job 扩展

`ResearchJob.kind: "full" | "angles"`（缺省 full）。angles job 走同一 runner（租约、心跳、结算、回报）；投递即返回回执；完成后 CAS 推进 `briefRevision`；同选题有在途 job → 拒绝并回报「研究进行中」。

### 3.6 视角输出

`PerspectiveOutput` 新增可选 `inferences?: { text: string; persona?: PersonaKey }[]`（无来源的受众推断）与 `partialProblems?: string[]`（校验剔除的条目）；`insights` 语义不变（每条必须有来源）。不 bump。

## 4. 模块改动

### 4.1 立意 pass（新 `src/modules/research/angle-stage.ts`）

- 输入：快照事实字段 + own-material + 三画像 + 选题。工具 `submit_angles`。
- **脚本校验**（硬）：形状；枚举；`coreEvidenceIds` 存在性；`firsthandAnchor` 引用存在 + quote 逐字命中；`evidenceLevel` 与引用一致；元素 ≥2 且不全新奇点；三画像收益非空；`evidenceNeeds` 1–3；thesis 互不重复（沿用 `checkDistinct`）；身份自嘲词表；劝退词表打分。
- **语义判据不假称代码校验**（codex #20）：机制是否因果、payoff 是否大白话、主张是否比喻/复述——由审稿第三类判据（§4.5）在成稿时判，立意 pass 只在 prompt 里要求。
- 打分（展示/排序）：元素数（≤3）+ grounded +1 + `firsthandAnchor` 校验通过 +2 + 主画像 grow +1 − 劝退词表 3。
- 路由 `scout`；`maxTurns 5`、`60k`；修复 ≤2；失败 → brief 无卡 + `gaps` 记录。
- `research-synthesis.ts`：删 `angle_cards`/`angleSuggestions` 产出与校验，prompt 删「角度」段；综合结果 `angleSuggestions: []` 由代码写（读侧、注入层、前端要求该字段存在）。`readAngleCards` 迁至 angle-stage 并支持 overview。

### 4.2 定向补证（新 `src/modules/research/targeted-research.ts`）

- `createTargetedResearcher({ dataDir, config, runLoopImpl?, ledger, signal })`；broker 同 `createResearchBroker`，配额**用受类型检查的 `Partial<BrokerQuotas>`**：`searchPerPerspective 5 / readPagePerPerspective 8 / searchPerJob 40 / readPagePerJob 60`；测试断言 usage 上限。
- 每需求：独立 `AbortController` + `RunState.abandoned`，**墙钟 3 分钟**；超时冻结该 lookup（status `timeout`），loop 不再消耗配额、晚到提交丢弃。三需求并行，结果按需求序归并。补证阶段总墙钟 6 分钟。
- 调用点：`generate-script.ts` 在 `resolveAngle` 之后、装配之前；手写 direction / skip_reason / 无卡 → 不补证。搜索未配置 → warn + 跳过 + 版本注记「未补证」。
- 渲染：`externalBlock` + `sanitizeExternal` + URL 只显示域名（原 URL 在账本）；块级上限。

### 4.3 输入预算装配（codex #14）

替换现有「用户材料在前 + 简报块 2800 + 知识库补位」的 4000 槽：

| 优先级 | 内容 | 上限 |
|---|---|---|
| 1 | 选中卡核心证据（`coreEvidenceIds`）+ 补证块 | 4000 |
| 2 | 简报块（`buildBriefBlock`，去掉已在 1 的证据） | 2800 |
| 3 | own-material 锚点片段 | 2000 |
| 4 | 用户 `research` | 2000 |
| 5 | 口吻参考（其余 own-material） | 1500 |
| — | 知识库 | 剩余 ≥400 才注入 |

总上限 12000 字符；装配产出一份**快照**，写手与审稿复用同一份（审稿 `RESEARCH_MAX_CHARS` 从 6000 改为读快照，不再二次裁剪）。

### 4.4 写手与提交（`generate-script.ts` / `script-payload.ts` / `quality-gate.ts`）

- 工具箱：`submit_script` + `find_evidence`（账本 + 共享预算）；修订轮挂**同一实例**。
- `maxTurns = 4 + lookups(3) + repairs×2`，不依赖 pack 是否有 gate；整稿墙钟 15 分钟。
- 角度块 v3 渲染（`buildAngleBlock`）：主画像/误区/机制/主张/动作/三画像收益/元素/反方/锚点/骨架/收获感 + 硬规则（前 3 秒误区提问；一稿一主张；结尾最小动作；术语翻译；证据纪律；自嘲边界；转写用法；无镜头标注）。
- **口播格式硬门**（pack 无关，`GateFailure.check` 新增 `"format_markers"`）：四字段任一含 `[画面]`、`【画面】`、`[字幕]`、`[字幕条]`、`[口播]`、`[切`、`B-roll`、`镜头一/二` 等变体 → 拒绝并要求去除。`koubo.ts` `platformAdjustments.douyin.style` 改为「纯口播正文，3 秒内出钩子」。
- **数字硬门**（`number-gate.ts`）：
  - 提取范围：title/hook/body/cta 四字段。
  - 归一：阿拉伯数字（含全角、千分位、小数、负数、科学计数）、中文数字词（九万五千、三成、三分之一、两/半/十几/数十）→ `{ value, scale, unit, range?, polarity }`；无法确定的中文数量词 → `needs_human` 标记（不静默通过）。
  - 匹配：只对账本条目做 token 边界匹配，值相等且单位兼容（`%` 与「百分点」不兼容；`9.5万` ≡ `95000`）。
  - 豁免：只有明确语法角色的序号（第 N、列表编号）、版本号（`v1.2`、`0.1.0-rc.6`）；**年份与时间单位照验**。
  - 来源分级：命中 `verified_quote` = 已核验；命中 `own_claim` / `user_claim` = 允许但标 `claim`；无命中 = 拒绝，列出数字要求「删除 / 改成材料里的数 / 用 find_evidence 找」。
  - 与质量门共用修复计数；**耗尽后不得 `draft_ready`**：稿件状态 `needs_evidence`，保留最后一版与未核验清单，看板可见；`[未证实]` 只是诊断文本，不是放行口。
- 归因（run-log + `Content.attribution`）：`usedBrief {revision, hash}`、`usedAngle {id, cardVersion, hash}`、`ownMaterial refs`、`lookups[] {need, status, itemIds}`、`angleSkipReason`；写手启动前随占位稿落一次。

### 4.5 审稿（`script-review-prompt.ts` / `script-review.ts`）

第三类判据「立意执行」，有卡时启用：主画像动作没达成 / 误区未在前 3 秒点出或未反驳 / payoff 未兑现 / 主张不可反驳（复述材料）/ 机制只是比喻 → blocker；元素 <2、无最小动作、含 `needs_human` 数字 → advisory。
删除「不要凭空要求补数据」条款；改为「无据数字已被硬门拦下，审稿不再判数字」。`canFindEvidence` 开关显式传入且与修订轮工具箱一致。

### 4.6 UI 与聊天

- `AngleCards.tsx` / `chat/cards.tsx` / `frontend/lib.ts` / `angle-choice.ts`：v2/v3 联合类型；v3 显示主画像、误区、机制、收获、证据需求、分数（排序用）；改写表单含 v3 字段。
- `chat-router.ts` `needsAngleReply`：每卡「主画像 · 主张 · 收获」；规则 27 不变。`angleGate` 与 `selectAngle` 改用快照。
- `regenerate_angles(topicId)` chat 工具 + IPC：投递 angles job，回执；完成走现有回报轮（`chat-followup`）。
- 补证与账本展示在稿件 Editor（content 级），不在 `ResearchPanel`（topic 级）。
- `research-handlers.ts` / `ipc.ts` / `channel-contracts.ts`：angles job 投递与状态。

### 4.7 调研上游

`research-perspectives.ts`：校验剔除只剔条目，剩余 `insights ≥1` 即 succeeded 并写 `partialProblems`；受众视角推断进 `inferences`。

## 5. 边界行为

| 情形 | 行为 |
|---|---|
| 简报无 evidence | 立意 pass 仍跑，只能产 overview 卡（`evidenceNeeds ≥2`）；UI 标「综述级」 |
| 立意 pass 失败/超时 | brief 无卡 + gaps；写稿走无卡路径；UI 可投 angles job |
| angles job 与 full job 冲突 | 拒绝并回报「研究进行中」；job 结算用 CAS，晚到结算不覆盖更新的指针 |
| 补证全空 / 超时 / 未配搜索 | 账本记 status；写手收到「没有证据，不要编」；版本注记 |
| 数字无据且修复耗尽 | 稿件 `needs_evidence`，不 `draft_ready`；看板徽章；创始人可改稿或补材料后重跑 |
| 中文数量词无法归一 | `needs_human`，放行但审稿 advisory + 看板可见 |
| 创始人改写卡 | 服务端校验 v3 必填、重算 score；改 `firsthandAnchor.quote` 需重新命中 |
| 存量 v2 卡 / 无卡简报 | 只读兼容；`regenerate_angles` 出 v3 新 revision |
| 手写 direction | 不补证、不做角度块 v3；数字硬门与格式硬门仍生效 |
| 修订轮 | 同账本、同预算、同工具实例 |
| 客户端提交 score | 丢弃，服务端重算 |

## 6. 测试与验收

- 单测：`resolveEffectiveBrief`（指针 vs 磁盘最大版分歧）；angles job CAS 与在途拒绝；卡 v2/v3 联合解析与 `parseAngleCard`；`firsthandAnchor` 引用校验；own-material 版本排序/同选题排除/上限/定界；补证配额断言、超时冻结、晚到提交丢弃、归并顺序；账本共享预算跨写手与修订；数字门归一与对抗样例（`5` vs `15`、`30%` vs `30 元`、`9.5万`、年份、版本号、全角、中文数量词、`needs_human`）；格式硬门变体；输入预算装配优先级与写手/审稿快照一致；run-log 归因在生成失败时仍落盘；三入口（聊天/工作台/MCP）快照一致。
- 命令：`npm run check && npm run fe:build && npm run smoke`。
- 真 LLM 验收：三个 P0 选题走生产路径 `deep_research`（或 `regenerate_angles`）→ **人工选卡** → `generate_script`；产物按 P0c 盲评格式给创始人；验收线：可发 ≥3/6，`needs_evidence` 0 篇，`needs_human` 数字全部人工过目。

## 7. 分期

| 期 | 内容 | 依赖 |
|---|---|---|
| P1a | 3.0 快照、3.1 卡 v3、3.4 画像、3.5 angles job、4.1 立意 pass、4.6 UI/聊天/regenerate | 无 |
| P1b | 3.2 own-material、3.3 账本、4.2 补证、4.3 装配、4.4 写手/硬门/归因 | P1a |
| P1c | 4.5 审稿、4.7 调研上游 | P1b |

## 8. 裁决（v2 立场，采纳 codex）

1. 数字核验：**严**。独立硬门，修复耗尽不转正，`[未证实]` 不是逃生口。
2. 三画像：P1 放代码里的带版本模板；现有 core 只作补充上下文，不映射为 convert；设置页 P2。

## 9. 明确不做

案卷制；dsh 员工子 agent；审稿 300s 超时治理；`STYLE.md`；比喻/因果的代码判定（交审稿 LLM）。

## 10. codex 处置表（2026-09-04，28 条：25 P1 / 3 P2）

| # | 要点 | 处置 |
|---|---|---|
| 1 | 删 angleSuggestions 会让读侧判坏 | 吸收：§4.1 代码写 `[]`，字段保留 |
| 2 | 无 evidence 出卡与 `coreEvidenceIds ≥1` 冲突 | 吸收：§3.1 `evidenceLevel` grounded/overview |
| 3 | 必填 vs 全可选矛盾 | 吸收：§3.1 `cardVersion: 3` 联合类型，旧卡只读兼容 |
| 4 | 两套「最新简报」 | 吸收：§3.0 单一快照，只认 job 指针 |
| 5 | saveBrief 不推进指针 | 吸收：§3.5 angles job + CAS |
| 6 | angle-only 不能同步 | 吸收：§3.5 job 投递即返回 |
| 7 | 自动选卡破坏优先级 | 吸收：§3.1 score 只展示排序，永不写 selectedAngle |
| 8 | firsthandAnchor 无校验 | 吸收：§3.1 结构化引用 + 逐字命中 |
| 9 | usedOwnMaterial 归因不足 | 吸收：§3.2 片段 id + hash，立意/写手分记 |
| 10 | 补证配额字段名错 | 吸收：§4.2 类型检查 + usage 断言；§0 诚实说明 |
| 11 | 补证无墙钟 | 吸收：§4.2 per-need Abort + 阶段总墙钟 |
| 12 | 抖音无 gate、写手 4 轮 | 吸收：§4.4 turn 预算公式 + 整稿墙钟 |
| 13 | 写手/修订各自预算 | 吸收：§3.3 共享账本 + 预算 |
| 14 | 研究槽预算被打破 | 吸收：§4.3 输入预算装配，写手/审稿同快照 |
| 15 | run-log 归因缺 | 吸收：§4.4 归因清单，占位稿先落 |
| 16 | 渲染未消毒 | 吸收：§3.2/§4.2 externalBlock + 域名 |
| 17 | 字符串级数字核验是伪核验 | 吸收：§4.4 归一元组 + 单位兼容 + 来源分级；§0 更正实验表述 |
| 18 | 白名单放过假数据/误杀 | 吸收：§4.4 只豁免语法角色，四字段全验，`needs_human` |
| 19 | 修复耗尽转正 | 吸收：§4.4 `needs_evidence` 状态，不转正 |
| 20 | mechanism 判不了比喻 | 吸收：§4.1 语义判据交审稿，代码只校形状 |
| 21 | 审稿不知修订轮有无工具 | 吸收：§4.5 删补数条款 + `canFindEvidence` |
| 22 | 镜头标注 gate 对抖音不执行 | 吸收：§4.4 pack 无关格式硬门 + 新 check 枚举 |
| 23 | ResearchPanel 无 content；文件清单不全 | 吸收：§4.6 Editor 展示 + 触点补全 |
| 24 | inference 改变 insights 语义 | 吸收：§3.6 新增可选 `inferences`/`partialProblems` |
| 25 | 验收缺选卡；命令不存在 | 吸收：§6 人工选卡 + `npm run check/fe:build/smoke` + 测试清单 |
| 26 | core 不能映射 convert | 吸收：§3.4 |
| 27 | transcript 版本字符串排序 | 吸收：§3.2 数值排序 |
| 28 | STYLE.md 是空操作 | 吸收：删 |

## 11. P1a 落地记录（2026-09-05）

commits `7126659`（卡 v3 + 立意 pass + 单一快照 + 前端）、`0075149`（angles job + CAS + regenerate_angles）、`9f4fe3e`（劝退词表补漏）。typecheck 干净、lint 0 错、3981 测试绿、`fe:build` 过。四片实施由 opus 子 agent 完成，本人整合与验收。

**端到端验收**（隔离目录，生产 `~/.autocrew` 只读；DeepSeek V4 Pro，中转仍不通）：三个 P0 选题各投一个 angles job，指针均从 v1 推到 v2，各 4 张 v3 卡，落定 195–435 秒；v1 文件字节不变。样例：「你改了 AI 的错」angle-1（grow，7 分）主张「纠正默认存进了会消失的易失内存，不进持久层的纠正等于没纠正」——与创始人 P0c 可发稿同一主张。

**实测修正**：立意默认墙钟 4→8 分钟（首跑 240s 超时）；劝退词表补「别现在上生产|不要上|别拿|劝你」（首跑最高分卡就是这一族，词表没抓到）。

**已知限制（交 P1b）**：三个选题 12 张卡**无一张第一手锚点**——本刀只认简报证据，创作者转写要等 own-material；分数只排序，「投票」比喻族仍会得高分，判断在选卡与审稿。
