# AutoCrew 进 dsh：数字员工定义 + 案卷制事实共享（设计稿 v3）

日期：2026-09-02 · 状态：v3（v2 吸收 codex 26 条见 §10；v3 按创始人裁决撤销采访门、加内部调研腿、P0 重设计，见 §11）· 前置：[dsh 工具桥第一刀](../../../adapters/dsh/README.md)（已合入本分支）· codex 会话 `.context/codex-session-id`

## 0. 一句话

**把「阶段间传裁剪过的摘要」改成「所有员工通过业务读取工具读同一份案卷」，把「只搜外网」改成「先挖创作者自己的语料再搜外网」；创作者不提供任何输入，产品的预期就是全自动调研出优质短视频文案；agent 基础设施（循环、子 agent、任务、会话、重试）交给 dsh，AutoCrew 只定义员工、案卷、提交契约和恢复。**

**设计前提（创始人 2026-09-02 裁决）**：纯外网调研在 FDE 赛道的上限是「资料翔实的综述」，到不了「只有他知道的事」。要突破这个上限，来源只能是创作者**已经产出过**的东西——口播转写、审定稿、灵感收件。所以内部语料不是锦上添花，是这个产品在这个赛道上唯一能到「优质」的路径。任何要求创作者额外做一步的输入（事实包、采访）一律不做，同 [[feedback-loop-implicit]]。

## 1. 诊断（假设级，待 P0 实验证实）

### 1.1 主假设：写手输入贫瘠，而非模型能力

`~/.autocrew/engine.json` 的 `routes.writer` / `routes.reviewer` 配的是 `claude-opus-4-8`（走中转）。这只证明模型名相同，**不证明**与你在聊天里用的 Claude 同快照、同采样、同 system prompt；AutoCrew 还叠了质量门、人味化正则、自动审修环。所以「同一模型写得差」是假设，P0 要固定 resolved provider/model 并记录完整请求才能下结论。

写手实际拿到什么（`src/modules/writing/script-prompt.ts:61`，材料汇集在 `generate-script.ts:282`）：

| 输入 | 实际情况 | 来源 |
|---|---|---|
| `req.topic` | 自由文本，**只有标题 + 角度**；选题库里的 `description` 不会自动带上 | `chat-router.ts` 调用方拼 |
| `direction` | 用户原话，**无上限**（角度卡字段才有 200 字上限，`ANGLE_FIELD_MAX`） | 聊天 |
| 调研简报块 | `BRIEF_BUDGET = 2800` 字 (`brief-inject.ts:21`)，只渲染 summary/tensions/angles/evidence≤8/gaps | `research/briefs/*.vN.json` |
| 声音样本 | 每条 300 字 | creator-profile |
| 改稿对照 | 改动窗口 ±40 字、每侧 160 字、最近 3 条 | learnings/edits |
| 知识库 | 4000 − 简报占用，不足 400 即不注入 | knowledge/ |

落盘的 `brief.perspectives`（四视角结构化全文）**没有任何写作提示读过**；抓回的页面正文只存在调研 broker 内存缓存，job 结束即释放，写手、审稿、总编辑都看不到。

**更根本的缺口**：你在聊天里让 Claude 写稿时，倒给它的是你自己的 FDE 现场经历、判断、原话——对这个赛道来说，**创始人本人就是第一手事实源**。而这些材料很大一部分已经在磁盘上：45 篇历史稿（12 篇抖音口播稿、4 篇人审放行）、2 份你自己的口播转写（`contents/<id>/video/transcript.v1.json`，其中一份正是「DeepSeek Harness」这个选题你亲口说的 4281 字）、20 条灵感收件、3 条声音样本、19 条写作规则。**没有一条进过写手的提示词**——调研只搜外网，写手只拿 300 字声音样本。另：8 篇抖音稿里只有 2 篇带过简报，你对短视频文案的不满大部分样本是裸写的。

### 1.2 信息链在哪里断

内置的 审→修 环**没有**断链：审稿拿到与写手相同的 `researchSlot`、角度卡、声音样本（`generate-script.ts:424-452`），修订复用写手原 prompt（`script-review.ts:275-295`）。断的是成稿后的**独立**环节：`revise_draft`（无简报无角度）、`revise_focus`、平台适配 6000 字、封面 600 字、摘要 1200 字、受众审稿 6000 字。你在聊天里说「这段论据不够硬」，`revise_draft` 手里没有简报可查。

### 1.3 「多 agent」的真实形态

`runLoop`（`src/engine/loop.ts:276`）每次新建消息数组（装入调用方传的 `history`，总编辑会传对话历史），**模块之间不共享会话对象**；`skills/spawn-*` 三个「派发」技能是宿主 agent 内联执行的 markdown（`spawn-writer/SKILL.md:58` 自述「Removed sessions_spawn」）。阶段间只有再序列化文本 + 字数裁剪。

### 1.4 实证样本的诚实说明

全部 9 份简报的证据链（2026-09-02 从 `research/jobs.jsonl` + `logs/runs/*.jsonl` 拉取；scout 运行按选题标题在简报生成时刻 ±12h 内归属；7 月的两份早于 run-log 上线无记录；最后两份选题同名，归属合并了，数字要打折）：

| 简报 | 视角状态 | LLM 调用/失败 | tokens | search/read/read 失败 | submit 被拒 | 注入写手字符 | evidence |
|---|---|---|---|---|---|---|---|
| 8xj3we.v1 (7/26) | 4/4 | 无记录 | — | — | — | 2354 | 6 |
| 8xj3we.v2 (7/27) | 2/4：audience `engine_failed`、counter `invalid_output` | 无记录 | — | — | — | 912 | 0 |
| thcm3w | 3/4：evidence `invalid_output` | 43 / 3 | 37.6k | 24 / 32 / 4 | 8 | **2800（顶格）** | 8 |
| efy5eh | 4/4 | 51 / 3 | 42.1k | 32 / 31 / 0 | 6 | 2507 | 8 |
| rp5nb0 | 2/4：audience、counter `invalid_output` | 51 / 3 | 44.2k | 35 / 35 / 0 | 8 | 2197 | 6 |
| bc5vhv | 3/4：benchmark `no_submit` | 80 / 3 | 95.1k | 53 / 71 / 5 | 14 | 2317 | 4 |
| 2iityo | 4/4 | 63 / 3 | 59.0k | 41 / 50 / 6 | 10 | 2619 | 7 |
| lsba4l | 3/4：audience `invalid_output` | 59 / 0 | 194k† | 62 / 69 / 8 | 7 | 2321 | 8 |
| k6zesa | 2/4：audience、counter `invalid_output` | 59 / 0 | 194k† | 62 / 69 / 8 | 7 | 1904 | 8 |

† 同名选题归属合并。

读法：
- 9 个失败视角里 **7 个是 `invalid_output`**（提交校验两轮修复后仍不过），1 个 `no_submit`，1 个引擎错误。被拒原文两类：「引文在「pN」正文里找不到」和「合法洞察需 ≥2 条（每条带有效来源），当前 0 条」。即调研端的瓶颈是**引文逐字校验**把视角整段清零，不是模型不会搜——每份简报平均 30+ 次搜索、40+ 次读页、4–19 万 token 换来 4–8 条 evidence。
- 注入写手的简报块 1904–2800 字符，1 份顶到 `BRIEF_BUDGET` 上限；而这些简报本身 20–27KB。压缩比约 10:1。
- 9 份简报 **没有一份带 angleCards**（角度卡 R2 于 8/24 上线，存量简报未回填）。角度门对这些选题从未生效。
- 这些数字不否定「输入贫瘠」假设，但把它拆成两层：调研端**产出本来就薄**（校验剔除），写作端**再压 10 倍**。P0 的事实包实验只测第二层；第一层留待案卷制里 `read_source` 让写手能回看原文。

### 1.5 总编辑 bug 五根因（159 个提交归档）与 dsh 的边界

| # | 根因 | 代表 | 谁解决 |
|---|---|---|---|
| ① | 提示词许诺了工具层没兑现的能力 | `6006183` `a8e475b`，规则 4/10/15/20/21/25 | AutoCrew：能力清单一致性测试（§4.4） |
| ② | 静默截断当完整数据 | `c60ee7a`，历史窗 12 条卡片不进上下文，总编辑无工具读简报 | AutoCrew：案卷读取工具（§3.3） |
| ③ | 派发边界无幂等 | `f20b532` `80f4370` `fa14a75` | AutoCrew：租约锁 + fencing token（§3.5） |
| ④ | 请求-响应黑箱、轮次不可寻址 | `be9759e` `b8afa60` | dsh 提供通用机制：session 事件流、turn/abort、jobs |
| ⑤ | 传输层异构渗进编排 | `c77b580` `0ba42a9` | dsh 提供通用机制：`llm-retry`、pi-ai 适配；**对具体中转的 524/空响应/`reasoning_content` 是否正确分类仍要集成测试** |

**dsh 不提供、必须留在 AutoCrew core 的**：业务级恢复（dsh jobs registry 是 process-local，重启不恢复流水线）、案卷 CAS、阶段幂等、来源注册表与引文校验、exactly-once 提交、案卷浏览 UI。

## 2. 架构裁决

四级台阶逐环节定级：

| 环节 | 级别 | 理由 |
|---|---|---|
| 流水线编排 | **代码 workflow** | 步骤固定。不用 dsh `tool-workflow`（无 journaling/resume），不用 `ralph` 工具本身；代码定序，直接调 `ctx.subagents.start({outputSchema})`（programmatic 层才有 outputSchema，模型可见的 `subagent` 工具没有） |
| 人味化 / 质量门 / 发布前检查 / 案卷渲染 | 脚本 | 已是纯函数 |
| 总编辑 | 单 agent（dsh 会话主 agent） | 对话、派发、回报 |
| 内部调研（检索创作者语料） | **脚本** | 输入输出确定：按相关度从转写/审定稿/收件里挑，不需要模型 |
| 外网调研员 ×4 / 综合 / 写手·修订 / 审稿 | 子 agent | 路径不可枚举；审稿=故意的无知 |

**隔离的上下文**：外网调研员看委托书+选题+内部语料摘要（知道创作者已经说过什么，避免重复搜），不看声音库；写手看案卷（委托书、内部语料、简报、角度、规则、范文、上一版+审稿），不看原始网页、不看审稿判据；审稿看案卷+当前稿+判据，不看写手推理；总编辑看案卷与工作区状态，不写稿、不载入声音内核。禁 agent 互聊不变。

## 3. 案卷制

### 3.1 真相源与视图分离

**真相源 = 结构化 canonical store**（沿用现有 JSON 原子写风格，新增四类记录）：

| 记录 | 位置 | 说明 |
|---|---|---|
| `case.json` | `cases/<topicId>/` | caseId、shared 阶段状态、caseRevision 计数 |
| `own-material.json` | shared | **内部语料检索结果**（§3.4）：命中的转写/审定稿/收件片段 + 来源 contentId + 相关度；脚本产出，可重算 |
| `sources/<sourceId>.json` | shared | **抓取时即落盘**的页面快照：url、抓取时间、原文、标题、hash；broker 现有内存缓存改为先写后读 |
| `deliverables/<contentId>/brief.json` | 每稿 | 委托书：platform、audience、goal、must/avoid、evidenceMode、成稿标准 |
| `deliverables/<contentId>/decisions/<seq>.json` | 每稿 | 追加式裁决：原话、类型（改稿指令/采纳/打回/发布 diff 摘要）、时间 |
| `deliverables/<contentId>/status.json` | 每稿 | 阶段状态机 + handoff 收据（§3.5） |

现有 `topics/`、`research/briefs/*.vN.json`、`contents/<id>/`、`creator-profile.json` 不动，仍是各自真相源。

**Markdown 只是只读派生视图**，由业务读取工具**按需渲染**，不落盘、不需要「物化器」，也就没有 mtime 漂移和「读前重物化」问题。

### 3.2 目录：一个选题一份共享调研，N 份交付

```
~/.autocrew/cases/<topicId>/
  case.json
  shared/            内部语料检索结果、来源快照、（指向 research/briefs 的引用）
  deliverables/<contentId>/   委托书、角度选择、（指向 contents/<id> 版本的引用）、审稿、裁决、status
~/.autocrew/voice/
  rules.json         写作规则（现 creator-profile.writingRules 的搬迁或引用）
  exemplars/<contentId>.json  高采纳发布稿 + 入库原因
  anti/<contentId>.json       打回稿 + 原因原话（**只供蒸馏**，员工不直接读）
```

一选题多平台：外网调研与内部语料共享，委托书/角度/稿/审稿/裁决/状态按交付隔离，两条平台稿互不阻塞。

### 3.3 员工读案卷：业务读取工具，不给通用文件系统

dsh 的 `fs-sandbox` **只限写不限读**（README：reads always pass through），`toolFilter` 只是可见性过滤；`tool-fs` 也不提供目录列表；spill 对 `read` 不生效。所以员工**不挂 `tool-fs`**，只挂三个业务工具（在 AutoCrew 工具桥里实现，服务端做 caseId/租户/路径校验）：

| 工具 | 作用 |
|---|---|
| `case_manifest(caseId, deliverableId?)` | 目录 + 每个 artifact 的 id、字节数、摘要一行、当前 caseRevision |
| `read_case_artifact(artifactId, offset?, limit?)` | 渲染为 markdown 的只读视图；分页 |
| `read_source(sourceId, offset?, limit?)` | 来源快照；**输出裹「不可信外部数据」定界符**，沿用 `sanitizeExternal`；仅调研员与综合可见 |

**输入清单（input manifest）由代码生成**，按角色、去重、带 token 预算：写手必读 = 委托书 + 内部语料 + 简报 vN + 角度 + 规则；按需读 = perspectives（简报证据已含者不重复）、范文 ≤2 篇。实际加载清单记入 handoff 收据。现有 `BRIEF_BUDGET=2800` 等硬上限退役，由预算清单替代（不是无限制）。

### 3.4 委托书自动生成 + 内部调研：不问创作者一个字

- **委托书**由总编辑从选题（标题、描述、来源灵感卡）和创作者画像**自动生成**落成 `brief.json`，创作者可改但不必改；不再是前置门。`evidenceMode` 保留但改为脚本判定：内部语料命中 → `firsthand`（写手提示明示「以下是创作者自己说过的话」），未命中 → `external`（写手提示明示「本稿无第一手材料，只能写综述型」，审稿据此不把「缺亲历」记 blocker）。
- **内部调研**是调研阶段的第一步（脚本）：从 `contents/*/video/transcript.v*.json`（口播转写，最纯的第一手）、人审放行的稿子（approved/publish_ready/published）、灵感收件的拆解卡里按相关度检索，**排除同选题的 AI 旧稿**（否则是改写不是调研），结果落 `own-material.json`。P0 跑格器里的 `lib/internal-corpus.ts` 是它的最小实现。
- 外网调研员在任务书里拿到内部语料摘要：知道创作者已经说过什么，去搜他没说过的。
- 采访门**撤销**（创始人 2026-09-02 裁决，见 §11）。

### 3.5 阶段交接契约：租约锁 + fencing token + 收据

- **锁**：`O_EXCL` lockfile（`deliverables/<id>/.lock-<stage>`）+ lease TTL + 心跳 + 单调 fencing token。超时抢占后旧 owner 的迟到写入被 token 拒绝。
- **阶段冻结**：阶段开始时生成 `caseRevision` 输入快照（每个输入 artifact 的 digest）。创作者中途改委托书/裁决，或内部语料重算有变 → caseRevision +1；在跑阶段按旧快照跑完；下一阶段开始前发现 revision 变化 → **总编辑向创作者明示**「按新材料重跑调研还是继续」，不静默混用。
- **提交**：子 agent 内部仍用现有 `submit_*` 工具（保留循环内校验+修复），但 submit 只写**暂存区**（attemptId + token）；子 agent 结束后由编排代码校验 `outputSchema` 结果与暂存 artifact 的 digest 一致，再**一次事务**提交 artifact 收据与 stage 状态。**成功的唯一判据 = 提交收据**，`SubagentResult` 只作说明。
- **收据字段**：`attemptId, runId, stage, status(done|failed|partial|skipped), inputManifestDigest, outputDigest, schemaVersion, loadedArtifacts[], evidence, blocker?, token`。
- **恢复**：启动时 reconciliation 扫描未完成 attempt（有锁无收据）→ 标 failed/可续跑；`autocrew_run_pipeline({deliverableId, from})` 从最后一个 done 阶段续。

### 3.6 文案自我迭代

- `decisions/` 是追加式事实（改稿指令原话、采纳/打回、发布前最后一版 vs AI 稿 diff 摘要）。**不新增要用户点的按钮**。
- 蒸馏输入从 ±40 字窗口改为整份交付（发布版 vs AI 稿全文 diff + decisions + 委托书）；产出仍是 `writingRules`（scope 提升保留）+ 范文自动入 `voice/exemplars`（采纳率阈值沿用 `adoption-derive.ts`）+ 打回稿入 `voice/anti`。
- **anti 只供蒸馏**：蒸馏成带出处的反模式规则进 `rules.json`；审稿员只在「声音」维度以 advisory 读反模式规则，事实/论证/合规 blocker 不读 anti 原文（避免负向锚定）。
- 写手读范文 ≤2 篇全文（不是 300 字样本）。

## 4. dsh 插件形态

### 4.1 交付物

`adapters/dsh/` 扩展为 bundle，`dsh plugin --profile web add dsh-autocrew`：

1. **工具桥**（已有）：放行写作线工具 + §3.3 三个读取工具 + `autocrew_run_pipeline`。按 README 检查单逐个过。

   > **偏差记录（2026-09-04）**：这一批只放行了写作线的 12 个工具（`autocrew_init`/`status`/`dashboard`/`topic`/`content`/`generate`/`style`/`review`/`humanize`/`rewrite`/`pre_publish`/`workflow`），§3.3 的三个案卷读取工具与 `autocrew_run_pipeline` 尚未在注册表里存在，故不在本批。逐工具审计结论（含不放行的原因）见 `adapters/dsh/README.md` 的审计表；其中 `autocrew_research` 判定为**不合格**——适配器空手时会造占位选题并 `ok:true` 报成功，调研入口改由 `autocrew_workflow research` 承担。
2. **agent preset `autocrew`**（`adapters/dsh/agent-presets/autocrew/agent.cordis.yml`）。**dsh 限制（2026-09-02 实测）**：launcher `profile-boot` 合成时把 `agent-presets.roots` 整体覆盖成只剩自带根目录，bundle 无法经 patch 声明 preset 根；唯一路径是插件 apply 时把 preset 复制进 `$DSH_HOME/.agent-presets/autocrew/`（用户根，`includeUserRoot` 默认开），带版本戳幂等、只覆盖自带文件、可用 `installPreset:false` 关闭。组成：
   - `dsh-persona`：总编辑人设（§4.3）
   - `dsh-autocrew` 工具桥（含读取工具）；**不挂 `tool-fs`/`tool-fs-search`**
   - `skill-filesystem` + **`tool-skill`**（前者只发现，后者才是模型入口）指向 AutoCrew `skills/`；`surfaces: gui` 过滤迁为 invocation policy
   - `tool-todo`、`tool-ask-user`
   - **不**给总编辑挂模型可见的 `subagent` 工具：员工由 `autocrew_run_pipeline` 在代码里起（`ctx.subagents.start` + `persona` + `toolFilter` + `agentOptions.model` + `outputSchema`），总编辑只能派发流水线，不能自由 spawn
3. **流水线工具** `autocrew_run_pipeline({deliverableId, from?})`：后台 job；dsh 通知 + 案卷 status 双通道；重启后由 AutoCrew reconciliation 接管（dsh jobs 不持久）。
4. **案卷模块** `src/modules/casefile/` 在 core，两端共用。

### 4.2 两个前端，一份案卷

- 其他用户：dsh web UI 是总编辑对话面。**dsh 不会自动浏览 `~/.autocrew/cases`**（file-reference 只索引 session cwd）→ 案卷浏览走总编辑的 `case_manifest`/`read_case_artifact` 对话内展示；专用面板列为 P3。
- 创始人：工作台加「案卷」标签页，渲染同一批视图。常驻循环留在 AutoCrew daemon。

### 4.3 员工定义 = 人设 + 工具集 + 输入清单 + 提交契约 + 模型 + 预算

人设固定四段：①你是谁、为谁工作 ②先读 manifest，必读/按需读清单 ③产出走哪个 submit、通过标准 ④什么情况报 blocked 而不硬写。不写「不要假装 X」类补丁规则。

### 4.4 能力一致性测试（对付根因 ①）

建 capability manifest：每个员工声明「可见工具」；测试断言 persona 文本、可见技能正文、工具 guidance 段三者中出现的能力动词（读稿/搜索/推送/剪辑/生成图…）都能映射到该员工可见的工具，多余即失败。比 grep 工具名严格。

## 5. 边界行为（验收清单）

| 情形 | 行为 |
|---|---|
| 选题信息太少生成不出委托书 | 总编辑用画像默认值补齐并标「自动生成」，不问创作者；创作者随时可改 |
| 内部语料零命中 | `evidenceMode=external`，写手提示明示「无第一手材料」，审稿不把缺亲历记 blocker；总编辑回报里说明 |
| 内部语料命中的是同选题旧 AI 稿 | 排除；只有转写允许同选题（他亲口说的） |
| 调研全挂/部分挂 | status=failed/partial + 缺口；写手可继续，提示显式；总编辑用 failed 措辞 |
| 子 agent 未调 submit / outputSchema 不过 / digest 不一致 | 阶段 failed，收据记 stopReason/turns；重试 ≤1 |
| 同交付同阶段重复派发 | 锁在 → 返回在跑 attemptId |
| 创作者中途改委托书 | caseRevision+1；下一阶段前总编辑明示选择 |
| 案卷超预算 | 输入清单截断项显式列出「未加载」，写手可 read 分页补 |
| 网页内容含提示注入 | 只经 `read_source` 定界读取；写手不可见 |
| dsh 用户无 `~/.autocrew` | 首次创建 dataDir + 最小画像；总编辑首轮引导 |
| 服务重启 | reconciliation；`from` 续跑；锁 lease 过期 |
| 工作台与 dsh 同时操作 | 真相源原子写；decisions 追加式；status 走锁 |
| 一选题两平台同时写 | deliverables 隔离，共享调研只读 |

## 6. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| **P0 一天，创作者零输入** | 3×2 因子：{直写, 写手（审稿短路）, 全流程} × {brief=现状 2800 字摘要, full=简报全文+四视角+内部语料}。平台固定抖音口播。`full` 经现有 `research` 字段 RAW 注入且隔离目录不带简报指针（不叠加、不改代码）。固定 resolved provider/model，3 选题 × 6 格 × 2 重复 = 36 稿；盲评四维（事实性/观点/声音/结构）。跑格器 `experiments/p0-inputs-vs-structure/` | 调研档主效应显著 → §1.1 成立，P1 直上；流程档为负 → 先修审修环；写手 > 全流程 → 审稿伤稿；有转写的选题分差更大 → 内部调研腿单独立项 |
| **P1 案卷制（core）** | canonical 记录、来源落盘、三个读取工具、委托书自动生成、内部调研脚本、输入清单、锁/token/收据、reconciliation、写手/审稿/改稿/适配走案卷、蒸馏改读整交付 | 5 个历史选题重跑盲评；`revise_draft` 能引用简报证据；kill -9 中途重启可续跑；双派发只跑一次 |
| **P2 dsh preset** | 先合入工具桥分支；preset `autocrew`、`autocrew_run_pipeline`、员工 persona、`autocrew-dev` profile 重链（现指向已删 worktree）。**只有 bundle/preset 骨架可与 P1 并行**，端到端要等 P1 契约冻结 | 干净机器 `dsh plugin add` 走完 委托书→内部调研→外网调研→稿→审；收据可查 |
| **P3 声音库 + 案卷面板** | exemplars/anti 自动入库、反模式蒸馏、dsh 侧案卷面板 | 采纳率曲线 |

## 7. 明确不做

- 不搬工作台进 dsh；不用 `tool-workflow`/`ralph` 工具；不给总编辑自由 `subagent`。
- 不做显式反馈按钮；不做 agent 互聊；不做 N 平台 N 写手。
- **不做采访门、不做事实包、不做任何要创作者额外输入的东西**（§0 设计前提）。
- 不把 `sources/` 给写手；员工不读 anti 原文。
- 不给员工通用文件系统工具。

## 8. 裁决点（v3 立场）

1. **采访门**：撤销。`evidenceMode` 由内部语料命中与否脚本判定（§3.4）。
2. **目录**：`cases/<topicId>/` 拆 `shared/` 与 `deliverables/<contentId>/`；`contents/<id>` 仍是稿件真相源，反向引用 caseId/deliverableId。
3. **审稿读 anti**：不读原文；读蒸馏后的反模式规则，仅声音维度 advisory。

## 9. 待创始人确认

- P0 盲评：36 篇口播稿，每选题 12 篇读完再打分（约半小时）。
- 选题已定（无需创始人选）：`2iityo` DeepSeek Harness 实战（有他本人口播转写命中）、`lsba4l` 入口之争（综述型）、`efy5eh` 你改了 AI 的错（中间）。

## 10. codex 评审处置表（2026-09-02，26 条：20 P1 / 6 P2）

| # | 级 | 要点 | 处置 |
|---|---|---|---|
| 1 | P1 | 「同模型」证据不足 | 吸收：§1.1 降为假设，P0 固定 resolved model 并记录完整请求 |
| 2 | P1 | 输入上限表有事实错误（120/600 是调研员的；direction 无上限；写手只收 req.topic） | 吸收：§1.1 表重画 |
| 3 | P1 | 审→修环并未断链 | 吸收：§1.2 改为「独立环节断链」 |
| 4 | P2 | 「26 个、messages=[]」表述过头 | 吸收：§1.3 改写 |
| 5 | P1 | 实证样本无 runId/usage | 吸收：§1.4 诚实说明 + P0 前补齐 |
| 6 | P1 | 真相源自相矛盾；网页正文只在内存 | 吸收：§3.1 canonical 记录 + 来源抓取即落盘；markdown 纯视图 |
| 7 | P1 | 物化器无法读前重物化，mtime 漂移 | 吸收：取消物化器，改按需渲染的读取工具 |
| 8 | P1 | status.json 不是 CAS | 吸收：§3.5 O_EXCL + lease + 心跳 + fencing token |
| 9 | P1 | handoff 校验弱、漏 partial | 吸收：§3.5 收据字段 + 事务提交 |
| 10 | P1 | 续跑无依赖失效语义 | 吸收：§3.5 caseRevision 冻结 + 明示选择 |
| 11 | P1 | 单 status 不支持多平台 | 吸收：§3.2 shared/deliverables 拆分 |
| 12 | P1 | 上下文膨胀、spill 不管 read | 吸收：§3.3 代码生成输入清单 + 预算 + 记录加载清单 |
| 13 | P1 | 裸网页落 md 退化注入防护 | 吸收：§3.3 `read_source` 定界 + 写手不可见 |
| 14 | P1 | fs-sandbox 只限写；toolFilter 非边界 | 吸收：§3.3 不给 tool-fs，业务读取工具 + 服务端校验 |
| 15 | P1 | 缺 tool-skill、无目录列表 | 吸收：§4.1 补 tool-skill；目录由 case_manifest 提供 |
| 16 | P1 | dsh web 不会浏览案卷目录 | 吸收：§4.2 对话内展示，面板 P3 |
| 17 | P1 | outputSchema 在 programmatic 层不在模型工具 | 吸收：§2/§4.1 编排代码直调 `ctx.subagents.start`，总编辑不挂 subagent 工具 |
| 18 | P1 | submit 与 outputSchema 双提交源 | 吸收：§3.5 submit 进暂存，编排校验 digest 后一次提交，收据为唯一成功判据 |
| 19 | P1 | dsh 不提供业务恢复/CAS/exactly-once | 吸收：§1.5 明确列入 core + reconciliation |
| 20 | P2 | ④⑤ 承诺缩小 | 吸收：§1.5 改「通用机制」+ 集成测试 |
| 21 | P2 | grep 工具名不是契约审查 | 吸收：§4.4 capability manifest 测试 |
| 22 | P1 | P0 三组同时改多变量 | 吸收：§6 改 2×2 + 消融 + 重复 |
| 23 | P1 | P1/P2 并行只对包装成立 | 吸收：§6 P2 仅骨架并行，先合桥分支 |
| 24 | P1 | 采访门按 evidenceMode 自适应 | 吸收：§3.4/§8.1 |
| 25 | P1 | shared/deliverables 拆分 | 吸收：§3.2/§8.2 |
| 26 | P2 | 审稿不读完整 anti | 吸收：§3.6/§8.3 |

## 11. v3 变更记录（2026-09-02，创始人裁决）

创始人原话：「我没给他事实包，我对这个产品最终的预期就是他能自动调研然后出优质的短视频文案。」据此：

| 项 | v2 | v3 |
|---|---|---|
| 采访门 / 事实包 | 采访 ≤3 问作为写稿前置门 | **撤销**。任何要创作者额外输入的东西不做 |
| 第一手材料来源 | 创作者口述 | **内部语料脚本**：口播转写、人审放行稿、灵感收件，按相关度检索（§3.4） |
| 委托书 | 总编辑从对话逐项问出 | 从选题 + 画像自动生成，可改不必改 |
| `evidenceMode` | firsthand/optional 由内容类型定 | 由内部语料命中与否脚本判定 |
| P0 | {直写, 全流程} × {无事实包, 事实包} | {直写, 写手, 全流程} × {brief 2800 字, full 全文+内部语料}，创作者零输入，36 稿 |
| 设计前提 | 无 | §0：纯外网调研上限是综述，内部语料是到「优质」的唯一路径 |

codex 第 24 条（采访门按 evidenceMode 自适应）的处置随之改为「采访撤销，evidenceMode 保留但改脚本判定」。
