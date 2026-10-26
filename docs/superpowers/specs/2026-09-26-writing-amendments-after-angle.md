# 选卡后的写作选择：亲历借锚点，篇幅口吻措辞走写作补充，都不作废调研

> 状态：终稿 v2.1（2026-09-26）。codex consult 两轮共 17 条全部核过代码并吸收（§9）。待创始人批准；批准前不改代码。
> 起因：2026-09-26「AI 该想多久」抖音口播（`topic-1790392560545-koljj2`）选卡时创始人补了两句只影响写作的话，进不了任务书。
> 代码引用：全部是 main = `dbd57f0`，也就是守护进程 :4317 实际在跑的代码（§1.1 核过）。

## 0. 一句话

`requirements` 在 `prepare` 那一刻冻结给调研，之后原样沿用。选卡之后才定的写作选择分两路进任务书，都不碰调研哈希：

- **亲历用哪一段**：在系统里是立意卡上的「第一手锚点」，由代码校验出处，自由文本改不动它。选卡时用 `select_angle{anchor_from}` 从同一份简报的另一张卡上借锚点（只借创始人自己的转写或成稿）；领包时按片段 id 直接取回锚点原文，截一段放进写作包，确保写手和审稿都真的看得到。
- **篇幅、口吻、措辞、结构、交付格式**：走 `autocrew_writer pack` 的新参数 `writing_amendments`，进写作包和审稿任务书。

宿主若仍把这些追加进 `requirements`，拒单时给出差异和两条路，由宿主按创始人原话挑；产品不替谁挑。

## 1. 现状（全部有出处）

### 1.1 守护进程跑的是哪份代码

- :4317 是 PID 28029，`2026-09-25 17:44:31 CST` 起，命令 `node --import tsx/dist/loader.mjs /Users/jiaxintang/Projects/autocrew/desktop/server.ts`，cwd 是主 checkout。tsx loader 不带 watch，启动时装载的代码就是它一直跑的代码。
- 主 checkout 的 reflog：main 在 `17:44:31` 快进到 `1961809`，与进程启动同一秒；之后的 `dbd57f0`（18:19:53）只动了 `docs/evals/`、spec 和 `scripts/eval/scenarios.ts`，没有 `src/`。
- 主 checkout `git diff HEAD -- src desktop` 为空；未提交的只有 4 个技能文件（`skills/cover-generator/` 2 个、`skills/publish-content/` 2 个）。记忆里「守护进程跑 130 个未提交条目」已过时——那批代码 09-25 12:20 已进 `42a08c7` / `5fbb078` / `be107aa`。
- MCP 通道：`.mcp.json` → `bin/autocrew.mjs mcp`，是 stdio ↔ 守护进程 `/mcp` 的转发器，守护进程没起就报错，绝不另起第二个服务（`bin/autocrew.mjs:385-391`）。本次事故里每一次工具调用都打在这份代码上。
- 同一秒的竞态：即使进程在快进前一瞬装载了模块，`7dfed9a..1961809` 在 `scout.ts` / `writer*.ts` 里改的是 `claim_offline` 与补证，哈希相关文件（`creative-task.ts`、`writing-readiness.ts`、`workflow.ts`、`scout-task-guard.ts`、`research-runner.ts`）一行没动，结论不受影响。

### 1.2 事故复盘（`~/.autocrew/logs/runs/2026-09-26.jsonl` 与数据目录为证）

| 时间（UTC） | 调用 | 结果 |
|---|---|---|
| 03:16:07 | `workflow prepare{requirements}` | 建宿主调研任务 `rt-4e69d99e…`，任务书哈希 `af7a3755ef8f42a2` |
| 03:23–03:25 | `scout` 四视角 / 综合 / 立意 | 简报 v1、三张 v3 立意卡 |
| 03:37:15 | `workflow select_angle{angle-1, brief_revision:1}` | 选择落盘；`ready_to_write`，next_action 是 writer pack，参数里带着 prepare 时的 `requirements` 原文 |
| 03:37:29 | `writer pack`，`requirements` 末尾追加两行 | `writing_not_prepared`：「选题或本次创作任务（平台、要求、方向）已变化，旧简报已过期；需要按本次要求刷新调研。」哈希 `9d58008bd83271e9` |
| 03:37:59 | `writer pack`，`requirements` 换回逐字原文 | ready，`content-1790393879117-j2v9ag` |

- 失败的那次 `pack` 没写盘：简报 v1、job、宿主调研任务上的任务书按 `creativeTaskHash` 重算都还是 `af7a3755ef8f42a2`；`topic.selectedAngle` 仍是 `angle-1 / rev 1`。「angle.cards 清空」只是视图——过期时 `writing-readiness.ts:134` 不展示卡、`:136` 不解析已选卡。
- 如果宿主照 next_action 走：`workflow prepare`（新要求）→ `scout prepare` 回 `task_changed`（`scout.ts:355`）→ 确认后新建调研任务、job 置 running → 写作被 `researching` 挡住（`writing-readiness.ts:161-166`）→ 新简报出新 revision → 已选立意因 revision 不符失效（`angle-cards.ts:75`）→ 回到 `needs_angle`。这一轮从建任务到选卡用了 21 分钟（03:16 → 03:37），全要重来。
- 最后写成的稿（`j2v9ag`）任务书里：`requirements` 仍是「时长：待创始人确认（档案默认 8–10 分钟）」；时长碰巧对上，是因为档案的「视频时长：8-10分钟」作为「创作者内容规划（本次未另行指定时生效）」进了约定。
- 亲历那一句更糟，见 §1.8：就算当时进得了 requirements，也会和包里的硬规矩打架。

### 1.3 哈希怎么算、哪些字段进

`src/modules/writing/creative-task.ts`：

- `FIELDS = ["platform", "requirements", "direction"]`（`:12`）。
- `creativeTaskHash`＝对三个字段各自 `trim()` 后的 `JSON.stringify` 做 sha256，取前 16 位（`:32-36`）。只去首尾空白，中间多一个字就是另一份任务。
- `createCreativeTask(req, inherited)`：参数里给了用参数，没给继承（`:15-22`），显式空串清掉；`inheritCreativeTask` 只补这三个字段，其余字段原样留在请求里（`:25-29`）。
- `creativeTaskMatches`：冻结任务为空时只允许请求也没有 requirements / direction，否则比哈希（`:39-42`）。
- `renderCreativeTask` 渲染成「【统一创作任务书 · <hash>】调研、立意、写作和审稿须遵循同一份要求」+ 平台 + requirements 原文 + direction（`:44-53`），调研四视角（`research-perspectives.ts:206`）、立意（`angle-stage.ts:395,458`）、调研期自有材料检索（`scout.ts:376`、`deep-research.ts:395`）都读它。所以 requirements 进哈希是对的：受众、主张、类型真的会改变调研该查什么。

问题不在哈希，而在**只有这一个装要求的口袋**：调研要用的和只有写作要用的，挤在同一段自由文本里。

### 1.4 所有比对点，以及不一致时作废什么

| 比对点 | 谁调它 | 哈希不一致时 |
|---|---|---|
| `writing-readiness.ts:130-136, 173-176` | `workflow prepare / status / select_angle`（`workflow.ts:245,287,358`）、`writer pack`（`writer-prepare.ts:241`）、`generate.ts:189` | 简报判 `stale`，不展示候选卡、不解析已选卡，`status:not_started`，next_action 回 `prepare`（带新要求）；`writer pack` 由 `writingReadinessFailure` 包成 `writing_not_prepared`（`:54-70`） |
| `writer-prepare.ts:434-441` | 备料完成落盘前复核 | 备料作废，要求 `force:true` 重领 |
| `generate-script.ts:294-298` | 装配写作上下文 | 旧简报与立意不注入本稿 |
| `scout.ts:342-355` | `scout prepare / pack`（`workflow prepare` 会转到这里，`workflow.ts:246-252`） | `task_changed{diff, keep_current}`；带 `confirm_task_change` 后新建任务、已交视角不带过去、job 重置为 running |
| `scout.ts:431-441` | 带任务字段的研究动作 | `task_changed` |
| `research-runner.ts:194-212` | 引擎调研 `trigger` | 仅重跑立意被拒；在途任务不同则拒 |
| `deep-research.ts:425-428` | 引擎立意 job | `creative_task_changed` 失败 |
| `generate-script.ts:662`、`creative-task.ts:47`、`scout.ts:157`、`workflow-views.ts:31` | 提示词与回执 | 只显示「任务书标识」，不是门 |

`review_desk` 不比哈希：审稿读领包时冻结的 `pack.context.writingContract`（`writer-review.ts:186-190`、`host-review.ts:68-82,119`）。

### 1.5 写作包和审稿任务书从哪来

- 写稿提示词：`renderTaskPlan`（`script-prompt.ts:482-489`）把 `req.requirements` 放进「【本次写作要求（逐项落实，不得擅自替换）】」。
- 审稿任务书：`writingContract = renderCreativeTask(task) + buildWritingContract(profile, req, angle)`（`generate-script.ts:601`；`buildWritingContract` 在 `script-prompt.ts:506-513`，内含同一个 `renderTaskPlan`）。领包时冻结进 `pack.context.writingContract`（`writer-prepare.ts:406`），交稿收稿时写回稿件（`writer-review.ts:376`）。
- 领包请求 `req` 冻结在 `writing-pack.json` 的 `request.req` / `context.req`（`writer-prepare.ts:285,404-405`）。稿件上的 `genRequest` 只在备料期有效，**收稿即清**（`writer-review.ts:375`）。
- 结论：任何进了领包请求、又经 `renderTaskPlan` 渲染的东西，写稿和审稿都看得到。缺的只是一个不经过 `createCreativeTask` 的字段。

### 1.6 契约自相矛盾

- `autocrew_writer` 的 `requirements` 说明：「原样保留受众、提纲、必写/禁写、**篇幅、口吻**与修改反馈……**要求变化后需 force:true 换包**」（`writer.ts:67-69`）——把宿主往「领包时补进 requirements」上引。
- MCP instructions：「选定后用 workflow select_angle……领 writer pack。requirements 必须保留用户原话中的提纲、篇幅、口吻、必写和禁写」（`mcp/writing-instructions.ts:9`）。
- `write-script` 技能 pack 这一步写的是 `{action:"pack", topic_id, platform, requirements}`（`skills/write-script/SKILL.md:20`），没说要和 prepare 时逐字一致。
- 代码却把 requirements 的任何改动当成换任务。宿主照说明做，就撞墙。

### 1.7 已有但用不上的通道

- `editorial feedback{scope:"draft"}` → `content.writingFeedback`，同时进写作提示词与 `writingContract`（`writer-prepare.ts:362-367`），不碰任务书哈希。但它要 `content_id + draft_hash`（`editorial.ts:84-85`），语义是「对某一版稿的修改要求」，渲染时把当前正文当修改基底、优先级写成「修改要求 > 原写作约定」（`writing-feedback.ts:30`）。拿它装首稿前的选择要多走 pack → inspect → feedback → force 三步，还把写前选择贴上修订意见的标签。
- `pack{research}` 能带原文材料（登记为 `user-research` 未核验条目，`generate-script.ts:403`），但它是材料不是指令，也不能当亲历讲（§1.8）。

### 1.8 亲历在系统里是锚点，不是一句话

- 写作包的硬规矩：「第一手材料只用上面『第一手锚点』指定的那一处；其余创作者材料只供口吻参考，不得当案例讲」（`script-prompt.ts:407`）。锚点是立意卡上的结构化引用，`excerptHash` 由代码算、引文须逐字命中（`brief-store.ts:140-155`、`angle-stage.ts:150-160`）；写作时只有它对应的片段进「第一手锚点」块，其余进「口吻参考」（`generate-script.ts:339-367`）。
- 改写立意卡不能换锚点，也不能新增：`rewriteAnchor`「原卡没锚点就不能在改写里新造一个」「excerptHash 不可改」（`angle-cards.ts:207-219`）。
- 候选视图只露 `hasAnchor: true/false`（`workflow-views.ts:73`），宿主和创始人都看不到每张卡锚的是哪段。
- 本次数据：angle-1 的锚点是 `ev-1`，调研里 Anthropic 文章的一句「picked the wrong reading 25 → 47」，不是创始人的经历；「分工法」正是 angle-2 / angle-3 的锚点（转写 `content-1787132351005-lbrm59` 的「cloud 去出架构然后 code ax 去做审核」）。实际写作包 `writing-pack.md` 里，这段转写被归进「【口吻参考（只学他怎么说话，不得当案例讲，也不要说成『我做过』）】」（第 327 行；超预算没渲染出来，见下两条），而 `ev-1` 被写成「第一手锚点……这是创作者本人说过的话」（第 289 行）。**创始人要讲的亲历被明文禁止，调研引文反被当成他的话。** 任何自由文本（requirements 也好、新字段也好）都绕不过这条规矩。
- 领包时自有材料按选题重新检索，查询词不含任务书（`own-material.ts:361`，对比调研期 `scout.ts:376` 带 `renderCreativeTask`），得分为 0 的直接跳过（`:275`），且只收一段外选题转写（`:277`）。锚定的片段可能在领包时没被捡回来，这时锚点块为空，没有任何提示。
- 捡回来了也可能看不见：片段最长 4,500 字（`own-material.ts:88`），锚点块预算 2,000 字、口吻参考 1,500 字（`input-budget.ts:29-31`），`renderOwnMaterial` 装不下就整段丢（`own-material.ts:328`），只剩一个空标题。本次「分工法」那段转写 3,604 字：实际写作包第 327 行的「口吻参考」标题下面是空的，写手只在证据台账里见过它 80 字的节选（第 18 行）。**就算当时锚点换对了，亲历原文也进不了包。**

### 1.9 video-session 第 1 步

`skills/video-session/SKILL.md:21`：「平台……和目标口播时长没说就一次问清；其余照对话原话进 `requirements`。」它排在第 1 步、在写作线之前，但**没有明说要在 `prepare` 之前问**，也没说拖了的代价。这次初始要求里写着「时长：待创始人确认」，说明宿主知道没问，只是没意识到问晚了会让调研过期。亲历则天然要看了立意才定——步骤里也没有给它留去处。

## 2. 目标与不做

目标：

- G1 亲历取舍：选卡时能把同一份简报里另一张卡锚定的创始人材料借到选中的卡上；锚点原文确实进写作包「第一手锚点」块，审稿看到同一张卡、同一个锚点状态。调研任务书、简报不变。
- G2 选卡后、首稿前的篇幅、口吻、措辞、结构、交付格式，原话进写作包和审稿任务书；调研任务书哈希、简报、已选立意都不变。
- G3 宿主把补充放错地方（追加进 requirements）时，拒单说清「调研和立意都在、变的是哪几个字」，给出两条路；真要换任务仍须确认后重跑。
- G4 补充跨会话找得回，看得见（领包回执、写作包、审稿任务书）；锚点片段没进包时看得见。
- G5 边界写清：哪些改动不是写作选择，必须重跑调研。
- G6 时长在 `prepare` 之前问清（技能文案）。

不做：

- 不自动判断一段文字是「写作的」还是「调研的」（§3.9）。
- 不让任何自由文本指定亲历。
- 不支持借用「调研见过、但没被任何卡锚定」的片段（`brief.ownMaterialRefs`），留作后续（§8 第 1 条）。
- 不给 `workflow prepare / write` 加 `writing_amendments`，`select_angle` 也先不收它（§7 E 视 eval 结果再定）。
- 不做首稿之后的补充通道——那是 `editorial feedback` 的活，已有。
- 不做时长→字数的确定性门；不改工作台 GUI（GUI 没有 requirements 编辑入口）。
- 不改哈希算法、不改 `requirements` 过期语义、不改 `task_changed` 确认门；现有相关测试原样保留。

## 3. 方案

### 3.1 四个口袋，各管一段

| 口袋 | 什么时候定 | 谁读 | 进调研哈希 | 改了会怎样 |
|---|---|---|---|---|
| `requirements` | `prepare` 时，之后原样沿用 | 调研、立意、写作、审稿 | 进 | 简报过期，确认后重跑，已选立意随新 revision 失效（现状不变） |
| 立意卡（含借来的锚点） | `select_angle` | 写作、审稿 | 不进 | 选择按 `brief_revision` 绑定简报；已有包 → `pack_request_changed`（规划指纹变了） |
| `writing_amendments`（新） | 选卡后、首稿前，领包时 | 写作、审稿 | 不进 | 未有正文：`pack_request_changed` → `force:true` 换包；已有正文：拒，改走 `editorial feedback` |
| `writingFeedback`（已有） | 有稿之后 | 写作、审稿 | 不进 | 记原话 + 回执，下一次重领包生效（现状不变） |

「不进调研哈希」只保证**数据隔离**：调研代码读不到它们。它不保证**语义合法**——有人把受众改动塞进补充，代码拦不住；那一层靠宿主判断、审稿和创始人在任务书里看得见（§3.6、§3.7）。

### 3.2 亲历：选卡时借锚点（`anchor_from`）

- `workflow select_angle` 加可选参数 `anchor_from`：同一份简报里另一张卡的 id。服务端把那张卡的 `firsthandAnchor` **原样复制**到选中的卡上（kind / contentId / sourceRevision / chunkId / excerptHash / quote 一个不改），重算分数，存进 `topic.selectedAngle.card`。宿主不自己拼锚点对象，也就伪造不了出处。
- 能借的只有**已经挂在本简报某张卡上**的锚点——它们都过了立意那一步的产地校验。原卡已有锚点可以换掉（本次 angle-1 就是：把调研引文 `ev-1` 换成 angle-2 的转写），原卡没有锚点也可以补上；这两种现在的改写路径都不允许（`angle-cards.ts:207-219`）。
- **只借创始人自己的材料**：来源锚点必须是 `transcript` 或 `approved_draft`。`brief_evidence` 锚点是调研引文，借过来会被写作包当成「创作者本人说过的话」（`script-prompt.ts:415-422`），直接拒：「那是调研引文，不是亲历」。
- 拒单：`anchor_from` 不在本简报里；那张卡没有锚点或锚的是调研引文；选中的卡或来源卡是 v2 旧卡（v2 没有锚点字段）；同时给了 `card.firsthandAnchor`（二选一）。都回人话原因，不落盘。
- 候选视图把锚点摆出来：`cardView`（`workflow-views.ts:43-74`）在 `hasAnchor` 旁加 `anchor{kind, from, quote}`——`from` 是转写或成稿的标题，调研引文则标「调研引文，不是亲历」。创始人在选卡时就能说「用 1 的主张、2 的亲历」。
- **领包时按 id 直接取锚点原文**，不靠相似度检索：`own-material.ts` 加 `loadOwnChunk(dataDir, chunkId)`，按 `om:<contentId>:<kind>:<revision>:<index>` 读那篇稿的转写或成稿，消毒、按单段上限截取，与检索出的片段同形。只取调研期见过的片段（id 在 `brief.ownMaterialRefs` 里），所以同选题成稿的排除规则（`own-material.ts:238-242`）照旧成立。锚点一律用按 id 取回的那份（不受检索时剩余预算截断的影响），检索结果里的同 id 片段从「口吻参考」里去掉，不重复出现。`collectOwnMaterial` 本身不改，调研期行为不变。
- **锚点成立的判据**：片段取得到（同一篇、同一类、同一 revision），且锚点引文逐字（忽略空白，同 `verbatimIn`）在片段正文里。不比 `excerptHash`：它按剩余预算截断后计算（`own-material.ts:283-299`），同一段原文在不同位置会算出不同指纹，拿它判「原稿被改」会误报。
- **锚点块截窗口，不整段丢**：`renderAnchorBlock` 改为以引文为中心、在锚点预算内截取一段带边界的原文（前后标「……」，保留片段 id）。验收看结果：最终写作包和审稿材料里都要真的出现锚点引文。
- **锚点状态冻结在包里**：`context.anchor = {status:"ok"|"missing", chunkId, reason?}`。缺失时（稿被删、转写换了 revision、引文不在原文里）包照常 ready，回执带 `warnings:["anchor_missing"]`；写稿提示词的锚点行、`writingContract`、审稿输入三处都写「本稿不讲亲历（锚点原文缺失：<原因>）」，交稿时向创作者说明。立意卡与卡哈希不动，`finishReady` 的复核（`writer-prepare.ts:429-441`）不受影响。不静默降级。
- 借锚点改变了卡，`angleCardHash` 随之变化：已有写作包再领会回 `pack_request_changed`（`planningFingerprint` 含 `selectedAngle`，`writer-prepare.ts:173-181,229`），`force:true` 后生效。选择是按选题存的，同选题的其他平台稿也用这张卡。

### 3.3 `writing_amendments` 的契约

- 只挂在 `autocrew_writer pack` 上。类型 string，创始人原话；几条可以写在一起。
- 管的范围：篇幅 / 时长 / 字数；口吻、人称、节奏；必写或禁写的词句；已选立意之内的结构偏好（先讲故事再讲道理、结尾不喊关注）；交付格式；对亲历「讲不讲、讲多少」的限制。**不能**用来换亲历（走 §3.2），也不能换受众、平台、主张、题材范围（§3.6）。
- 优先级（只就「怎么写」这几方面）：本稿已采纳的修改要求（feedback）＞ 写作补充 ＞ 初始 requirements。补充在渲染上属于「原写作约定」的一部分，`renderWritingFeedback` 的「修改要求 > 原写作约定」（`writing-feedback.ts:30`）因此自然覆盖它，不用另改那句。三者都不能改动 §3.6 列的调研边界。
- 继承：不传 = 沿用本稿当前写作包里的值；显式空串或纯空白 = 清除。与 `research` 的写法一致（`writer-prepare.ts:220`）。
- 找回：原始值在写作包文件的 `request.req`（`pack_status` 与领包回执都回显）；渲染后的文本在稿件与包上的 `writingContract`。稿件 `genRequest` 收稿即清，不作为来源。
- 首稿之后：稿件正文非空（首次交稿过了门禁就会写正文；`force` 重领也保留正文，`writer-prepare.ts:204`「新稿提交前保留」）时，**改动**补充被拒，`code:"amendments_after_draft"`，next_action 指向 `autocrew_editorial inspect`（拿 `draft_hash`）再 `feedback`。不改、不传照常。判断放在写锁内（`startPreparation` 的 `serializeWriterCall` 段，重读稿件与包之后），不依赖会被重领清掉的 `pack.submittedAt`（`writer-prepare.ts:303-313`）。导入稿天生有正文，同样走 feedback——它本来就是修订。

### 3.4 数据流（逐文件）

**A. `writing_amendments`**

1. `ScriptRequest` 加 `writingAmendments?: string`（`script-prompt.ts:31`）。`CreativeTask` 不动，`createCreativeTask` / `creativeTaskHash` / `renderCreativeTask` 天然看不见它。
2. `renderTaskPlan`（`script-prompt.ts:482`）在「本次写作要求」块后加一块，**为空或纯空白时整块省略**：

   ```
   【选卡后补充的写作要求（创作者原话，与上面的要求同样逐项落实）】
   <原文>
   这几条是看过立意之后定的，调研时还没有，只管篇幅、口吻、措辞、结构和交付格式；这几方面与上面不一致时以这里为准。
   它不能换受众、平台、已选立意、题材范围，也不能换亲历（亲历只用「第一手锚点」那一处）。遇到这类冲突，按上面的要求和立意写，交稿时向创作者说明，由他决定改卡或重跑调研。
   ```

   写稿提示词（`buildUserPrompt`）与审稿任务书（`buildWritingContract`）都经过它；旧包回退 `packWritingContract` 用 `ctx.req` 重建时也带上。渲染这一块的函数单独导出，审稿侧（§3.7）用同一个函数剔除它。
3. 工具入参：`writer.ts` schema 加 `writing_amendments`，入参映射（`writer.ts:274` 附近）加一行；`PackParams` 加字段；`startPack` 组 `req` 时按「未传继承、空串清除」合并。
4. `requestKey`（`writer-prepare.ts:163-170`）加一项。早段的 `pack_request_changed`（`:227-238`）补两样：next_action（`autocrew_writer pack`，带 `content_id`、`force:true` 和完整生效请求，空串原样保留）；补充有变化时附 `amendments_diff{before, after}`，免得宿主 force 时悄悄丢掉旧补充。拒单文案的清单加「写作补充」。
5. 首稿后拒改（§3.3），在写锁内判。
6. 续接参数分流：`WritingReadinessRequest` 加 `writingAmendments`，只搬运、不进 `createCreativeTask`。`writingContinueParams`（`writing-readiness.ts:73-88`）**不改**，指向 `autocrew_workflow` 或引擎恢复的 next_action（`generate.ts:100-104` 等）永远不带补充。新增 `writerPackParams(topicId, req)` = `writingContinueParams` + `writing_amendments`，只用于指向 `autocrew_writer pack` 的地方：`writing-readiness.ts:216`、`writer-prepare.ts:252`、第 4 条的新 next_action、`writer-pack-view.ts:93-96` 的 `repackAction`、§3.5 的 `routes.writing_only`。
7. 领包 ready 回执（`writer-pack-view.ts:63`）回显 `writing_amendments`（非空时）；`preparation.research.creativeTaskHash` 本来就在，宿主可以原样告诉创始人「补充已进写作包和审稿，调研任务书没变」。

**B. `anchor_from`**

1. `workflow.ts` schema 加 `anchor_from`（仅 select_angle）；`doSelectAngle`（`:319-358`）在得到 `card`（原卡或改写卡）之后套用 §3.2 的借用与校验，用 `scoreAngleCard` 重算分数再落盘。
2. `cardView` 加 `anchor{kind, from, quote}`（只读展示）。
3. `own-material.ts` 加 `loadOwnChunk`；`generate-script.ts` 的 `gatherInputs` 在检索（`gatherOwnMaterial`，`:370-388`）之后，对生效卡的自有材料锚点按 id 补取、按 §3.2 判据定 `anchor.status`，再交给 `splitOwnMaterial`（`:339-347`）。
4. `renderAnchorBlock`（`generate-script.ts:353-359`）改为引文窗口；锚点缺失时 `anchorLine` 与写作约定输出「本稿不讲亲历」那句。
5. `PackContext` 加 `anchor`；`reviewInput`（`writer-review.ts:195-205`）与 `packWritingContract` 带上它，审稿看到的锚点状态与写手一致；领包回执带 `warnings`。

**C. 放错地方的接法**（§3.5）

1. `creative-task.ts` 加纯函数 `diagnoseTaskChange(frozen, requested)`。
2. `writing-readiness.ts` 过期分支与 `writingReadinessFailure` 用它。
3. `startPack` 早段改顺序：新旧请求的任务字段（platform / requirements / direction）不同时，先走只读的 readiness；未就绪就回它的诊断。就绪了（例如 provided / skip 模式没有简报可比，`writing-readiness.ts:147-158`）仍照原样做完整的 `requestKey` / `planningFingerprint` 比较，变了且没 force 必须回 `pack_request_changed`，不能落到 `reuseCurrent`（`writer-prepare.ts:257`）把旧包还回去。
4. `scout-task-guard.ts` 的 `taskChangedError` 附一段纯文字提示。

### 3.5 放错地方时怎么接住

宿主仍可能把补充追加进 `requirements`。今天的拒单只说「需要按本次要求刷新调研」，next_action 指向重跑；已有写作包时则先撞上没有 next_action 的 `pack_request_changed`（`writer-prepare.ts:227-238`），根本看不到差异。改成：

- **诊断**：`diagnoseTaskChange` 逐字段给 `before / after`。只有同时满足以下条件才给 `appended`：只有 `requirements` 变了；冻结的 requirements 去掉首尾空白后非空；新 requirements 以冻结原文（去尾部空白）开头；剩下部分去掉首尾空白后非空。改了中间、重排了格式、删了字，一律不给 `appended`。
- **readiness 过期分支**（`writing-readiness.ts:173-176`）：选题没变（`brief.topicHash === topicHash`）而任务书变了时，回 `code:"task_changed_after_research"`，带：
  - `task_diff`；
  - `preserved{brief_revision, creative_task_hash}`；`selected_angle_id` 只在选择仍对得上当前简报与选题时给（用 `activeAngleCard` 判），不对就不说「已选立意保留」；
  - `routes.rerun_research`：现在的 `workflow prepare`（新要求），条件写明「改了受众、平台、主张、题材范围或亲历来源；先告诉创作者会重跑调研、已选立意作废」；
  - `routes.writing_only`（仅在有 `appended` 时给）：`autocrew_writer pack`，`requirements` 用冻结原文，`writing_amendments` = 已有补充 + `appended`，条件写明「追加的只是篇幅、口吻、措辞、结构、交付格式」；没有 `appended` 时只给一句话：「若只是写作选择，恢复冻结的 requirements，把新增内容放 writing_amendments」。
  - `next_action` 保持指向 `rerun_research`，不自动走 `writing_only`。这条路下游还有 scout 的 `confirm_task_change` 确认门，照字面跟着走也不会误删什么；note 要求宿主按创始人原话挑，判不准就问一句。
- **已有写作包时**：按 §3.4 C3 调换顺序后，同样得到上面的诊断，而不是空洞的 `pack_request_changed`。
- **`select_angle` 不是无副作用的**：它先落选择（简报 revision 核对通过就落，`workflow.ts:351-355`），再返回 readiness。带着追加过的 requirements 选卡，结果是「选择已保存、任务书对不上」，同样拿到上面的诊断；恢复原 requirements 后选择自动生效。只有 `writer pack` 的拒单保证不写盘。
- **scout 那头只给文字提示**：`workflow prepare` 带新要求时会转到 `scout prepare`（`workflow.ts:246-252`），宿主看到的是 `task_changed`。当前任务已 `ready` 且诊断有 `appended` 时，附 `writing_only_hint`：「若新增的只是写作选择：不要确认，照原 requirements 继续（keep_current），领写作包时把新增内容放 writing_amendments；要换亲历用 select_angle 的 anchor_from」。scout 不知道是哪篇稿、已有什么补充，所以不替它拼参数。

### 3.6 边界：哪些改动不是写作选择，必须重跑调研

| 改动 | 为什么动调研 | 走哪条路 |
|---|---|---|
| 换平台 | 平台在哈希里；质量门、结构、表达习惯都变 | 同选题另开稿，新 `prepare` |
| 换受众（小林 → 老陈、非程序员 → 程序员） | 受众视角的调研和证据取舍按受众做 | 改 `requirements`，确认后重跑 |
| 换主张 / 立意 | 立意卡的主张和核心证据由调研产出 | 换一张卡；证据内的改写用 `select_angle{card}`；全新主张用 `direction` 或改 `requirements` 后重跑 |
| 换亲历来源 | 锚点是调研期校验过出处的引用 | 本简报别的卡锚过的 → `anchor_from`；没被锚过的 → 目前只能重跑（宿主模式不支持只重跑立意，`workflow.ts:193`），已知缺口 |
| 扩题材范围（加比较对象、换时间段、加一块新话题） | 调研没查过 | 重跑；只缺一两个事实用 `find_evidence` 按稿补证，不算扩范围 |
| 改内容类型（观点 → 教程、口播 → 图文） | 结构菜单与证据需求都变 | 重跑 |
| 改证据口径（只用官方来源、不用某家数据） | 证据池变 | 重跑 |

灰区判法：要重新决定「这篇讲什么、给谁看、凭什么」→ 调研改动；只决定「怎么说、说多长」→ 写作选择。判不准问创始人一句，不替他定。

### 3.7 审稿怎么用它

- 不改审稿 schema、不加审稿提示词：补充块与借来的锚点分别在 `writingContract` 和立意卡里，审稿本来就按「与写手收到的同一份规划」验收（`script-review-prompt.ts:252-253`），立意卡随 `reviewInput` 进审稿（`writer-review.ts:201-203`）。
- 逐项核对：时长对应的篇幅、禁写的词有没有出现、亲历是不是锚点那一段且细节不越出原文。
- **受众依据不能引补充**：`freezeAudience`（`host-review.ts:68-82`）冻结审稿依据时，另存一份剔除了补充块的任务文本；`parseAudience` 的 `current_task` 引文校验（`:136`）改为只比对这份文本。补充里即便夹了受众，也当不了审稿的受众依据。
- 越界：正文照着越界的补充写了（换了受众、写了卡上「不写」的范围）→ blocker，`rule` 写「写作补充越界」，`quote` 取正文里越界的那句。正文没照写的冲突，审稿 schema 只能引正文，落不了盘；由宿主交稿时向创始人说明（补充块已要求它这么做）。这是已知限制。

### 3.8 文案改动

- **`writer.ts` `requirements`**：「pack：prepare 时交给调研的那份完整要求，原样沿用（不传即继承）。调研后改它等于换任务：简报过期、要重跑调研。选卡后才定的篇幅、口吻、措辞放 writing_amendments；换亲历用 workflow select_angle 的 anchor_from。」
- **`writer.ts` `writing_amendments`**：「pack：选卡后、首稿前创作者补充的写作选择原话（篇幅/时长、口吻、必写或禁写的措辞、结构、交付格式）。进写作包和审稿任务书，不进调研、不作废立意；不能改受众、平台、主张、题材范围，也不能换亲历。不传继承，空串清除，变化需 force:true；已有正文后改走 editorial feedback。」
- **`workflow.ts` `anchor_from`**：「select_angle：用同一简报里另一张卡的第一手锚点（亲历）替换所选卡的锚点，填那张卡的 id。服务端原样复制，不接受自拼的锚点。」`angle_id` / `card` 的说明各加半句指向它；`requirements` 说明末尾加「调研开始后原样沿用；选卡后才定的写作选择走 writer pack 的 writing_amendments」。
- **`mcp/writing-instructions.ts:9`**：「……按它的 next_action 领 writer pack，requirements 原样沿用、不追加。prepare 时 requirements 要保留用户原话中的受众、提纲、篇幅、口吻、必写和禁写；选卡后才定的：换亲历用 select_angle 的 anchor_from，篇幅、口吻、措辞放 writing_amendments（进写作包和审稿，不进调研）；受众、平台、主张、题材范围变了才改 requirements 重跑调研。」
- **`skills/write-script/SKILL.md`**：`:11` 改成「prepare 时把受众、提纲、必写/禁写、篇幅、口吻完整写进 `requirements`，它冻结给调研、立意、写作、审稿共用」；`:15` 选卡处加「展示候选时把每张卡的亲历（`anchor`）一并摆出；他要 A 的主张配 B 的亲历，`select_angle` 带 `anchor_from:B`」；`:20` 改为「照 `select_angle` 回执的 next_action 领包，`requirements` 原样不动；选卡时另外定的篇幅、口吻、措辞加 `writing_amendments`（原话）」；另加一句边界：「改了受众、平台、主张或题材范围不是写作选择：告诉创作者要重跑调研、已选立意会作废，他确认后再改 requirements 重新 prepare。有稿以后的改法走 editorial feedback。」
- **`skills/video-session/SKILL.md:21`**：「第一次 `prepare` 之前一次问清：平台（只能一个：…）和目标口播时长，写进 `requirements`；其余照对话原话进 `requirements`。别为了和选卡合并提问往后拖——`prepare` 之后 `requirements` 冻结给调研，再改就要重跑调研、已选立意作废。」第 2 步加一条：「选卡时他才定的亲历用 `anchor_from`，篇幅、口吻、措辞领包时放 `writing_amendments`。」

### 3.9 为什么不选「给 requirements 的改动分类」

- **按词自动分**（diff 里只有「分钟」「字」就算写作改动）：一句「时长 8–10 分钟，受众改成老板」就漏过去；而且是看不见的魔法，出错时创始人无从知道调研被跳过了。
- **让宿主声明 `change_kind:"writing_only"`、哈希只算一部分 requirements**：调研看到的和写作看到的混在同一段文字里，审稿分不清哪几句调研没见过；等于让模型自报一个决定调研是否作废的布尔值——P6 刚把这类门收回到代码里（`7a8ddda`）。
- 分出独立的去处，数据隔离是结构上的；语义越界靠宿主判断 + 审稿 + 任务书里看得见。§3.5 的 diff 只用来展示和给路，不替谁做决定。亲历则干脆不走文本：它本来就是结构化引用。

## 4. 不变量与测试点

**A. 写作补充**

| 必须成立 | 强制点 | 测试 |
|---|---|---|
| 补充不进调研：任务书哈希、简报、已选立意不因补充而变 | `CreativeTask` 不含该字段 | `writing-readiness.test.ts`：带补充领包，`research.creativeTaskHash` 等于冻结值、不 `stale`、`ready_to_write` |
| 调研侧永远看不见补充 | 同上 + 续接分流 | `scout.test.ts`：同一选题带补充领包后，`scout prepare/pack` 回执与任务包 JSON 里找不到补充原文；调研期自有材料检索的查询只由选题与任务书构成 |
| 工具入参真的接上 | `writer.ts` 映射 | `writer.test.ts`：经 `executeWriter` 传 `writing_amendments`，包文件 `request.req.writingAmendments` 为原文 |
| 补充同时进写稿提示词和审稿任务书 | `renderTaskPlan` | `writing-contract.test.ts`：`buildScriptPrompts().user` 与 `buildWritingContract()` 都含补充块；`writer.test.ts`：`pack_md` 与 `context.writingContract`、收稿后稿件 `writingContract` 都有；`host-review.test.ts`：审稿包 `user` 与 `audience_context.writingContract` 含补充原文 |
| 没补充时提示词逐字不变 | 空时整块省略 | `writing-contract.test.ts`：带空串、带纯空白与不带该字段的输出逐字相同（仓库没有写作提示词的文件快照，不涉及 golden） |
| 领包幂等、换补充要 force、不静默丢旧补充 | `requestKey` + `amendments_diff` | 同补充两次领包同一 `pack_id`；换补充不 force → `pack_request_changed`，带 `before/after` 与可直接执行的 next_action（含 `content_id`）；force → 新 `pack_id`；不传继承；空串清除 |
| 所有重领路径都继承 | `previous` 取包文件 | 孤儿重跑（`restartOrphan`）、`repackAction`、feedback 之后 `revisionNextAction` 的 force 重领，三条都保留原补充 |
| 收稿、重启之后找得回 | 包文件 `request.req` | 收稿（`genRequest` 已清）后 `pack_status` 仍回显补充原文，稿件 `writingContract` 含补充块；守护进程重启后同样 |
| workflow / 引擎的 next_action 永不带补充；writer pack 的永远带当前值 | `writerPackParams` 分流 | `writing-readiness.test.ts`、`generate.test.ts`（`preparationHandoff`）、`writer-pack-view` 的 `repackAction` 各一条 |
| 首稿后补充只能走 feedback，重领也绕不过 | 写锁内按正文判 | 交稿 → feedback → force 重领（补充不变，通过）→ 再改补充（被拒，`amendments_after_draft`，next_action 指向 `editorial inspect`）；直接修订 `submit{revision_of}` 不受影响 |
| 补充当不了受众依据 | 冻结剔除补充块的任务文本 | `host-review.test.ts`：补充里写「受众改成老板」，审稿 `audienceBasis{source:"current_task", quote:"受众改成老板"}` 被拒；引初始 requirements 里的受众照常通过 |

**B. 借锚点**

| 必须成立 | 强制点 | 测试 |
|---|---|---|
| 只能借本简报里已有的创始人材料锚点，原样复制 | `doSelectAngle` | 借 angle-2 → `selectedAngle.card.firsthandAnchor` 与 angle-2 的逐字段相等；借不存在的卡、借无锚点的卡、借 `brief_evidence` 锚点、v2 卡、与 `card.firsthandAnchor` 同给，五种都拒且不落盘 |
| 借锚点不碰调研 | 卡存在选题上 | 借用前后任务书哈希、简报 revision、job 字节不变；`selectedAngleHash` 变化 |
| 锚点原文一定取得到，不靠检索运气 | `loadOwnChunk` | 三种检索会漏的情形都照样进包：领包期查询下得零分、被一段得分更高的外选题转写挤掉名额、调研时排在预算尾部；id 不在 `brief.ownMaterialRefs` 里的一律不取 |
| 锚点判据不误报 | 逐字引文，不比指纹 | 同一段原文在调研期被截短、领包时取得更长（指纹不同）→ 仍判 `ok` |
| 长片段也看得见 | 引文窗口 | 用本次 3,604 字的「分工法」转写做夹具：`pack_md` 的「第一手锚点」块与审稿材料都含锚点引文，块长不超预算；该片段不再出现在「口吻参考」里 |
| 缺失时写审两边一致 | `context.anchor` | 删掉被锚定的稿件或换一版转写 → 包 ready、`warnings:["anchor_missing"]`；写稿提示词、`writingContract`、审稿输入三处都写「本稿不讲亲历」；卡与卡哈希不变，`finishReady` 照常落包 |
| 候选视图露出锚点 | `cardView` | `anchor{kind, from, quote}`；调研引文标「调研引文，不是亲历」 |

**C. 放错地方**

| 必须成立 | 强制点 | 测试 |
|---|---|---|
| 调研后追加 requirements：不删任何东西，给差异和两条路 | §3.5 | 追加 → `task_changed_after_research`、`task_diff.requirements.appended` 等于追加文字、`routes.writing_only` 的 `requirements` 等于冻结原文、`next_action` 指向 `rerun_research`；前后 job / 简报 / 调研任务 / `topic.selectedAngle` 字节不变 |
| 纯追加判得严 | `diagnoseTaskChange` | 冻结为空、改中间、重排换行、只加空白、删字：都不给 `appended`，也不给带参数的 `writing_only` |
| 已有写作包时也拿到诊断 | §3.4 C3 | 先成功领包，再带追加的 requirements 领包 → `task_changed_after_research`，不是 `pack_request_changed` |
| 就绪了也不复用旧包 | §3.4 C3 | provided / skip 模式改 requirements、显式清空 direction：readiness 就绪，但仍回 `pack_request_changed`，不返回旧包 |
| `select_angle` 的副作用说清 | — | 带追加 requirements 选卡：选择落盘、回执是诊断；恢复原 requirements 后 `ready_to_write` 且解析出这次的选择；选择与简报对不上时 `preserved` 里没有 `selected_angle_id` |
| scout 那头同一句话 | `taskChangedError` | 已 `ready` 的任务只追加 requirements → `task_changed` 附 `writing_only_hint`；确认门行为不变 |
| 现有换任务语义不变 | — | `writing-readiness.test.ts:178`、`workflow.test.ts:442`、`scout-task.test.ts:63-70`、`deep-research.test.ts:994` 原样通过 |

**行为 eval**（`scripts/eval/scenarios.ts`，每场景 ×3，约 $2–6/场景；需新种子 `seedResearchedTopic`：调研已完成、两张以上 v3 卡锚在不同片段、含一段创始人转写）：

- `post-angle-writing-choices`：用户在选卡时说「选 1 的主张，亲历用 2 那段；时长 8–10 分钟」。按世界状态判：`select_angle` 之后没有 `scout prepare` / `confirm_task_change`；`topic.selectedAngle.card.firsthandAnchor` 等于 angle-2 的锚点；领包请求的任务书哈希等于冻结值；`writing_amendments` 含「8–10」；审稿包任务书含它。目标 pass^3 = 1。
- `audience-change-after-angle`：选卡时说「受众改成开公司的老板」。判：`writing_amendments` 不含「老板」；宿主要么停下来问，要么走了确认后的重跑。

真机验收：下一条口播，创始人选卡时顺口定亲历或篇幅 → 一次领包 ready → 写作包「第一手锚点」是他点的那段，审稿回执里能看到补充原话。

## 5. 失败态与 UX

| 情况 | 宿主 / 创始人看到 |
|---|---|
| 选卡时定了亲历 | 候选里每张卡都写着锚的是哪段；`select_angle{anchor_from}` 后回执里的卡带新锚点 |
| 选卡后定了篇幅 / 口吻 / 措辞 | 领包回执带 `writing_amendments`；宿主说「这几句已进写作包和审稿，调研和立意没动」 |
| 补充追加进了 requirements | `task_changed_after_research`：「调研（任务书 af7a…）和已选立意都在；变的是 requirements 末尾这两行：…。只是写作选择就走 routes.writing_only；改了受众/平台/主张/范围才重跑，先跟创作者说」 |
| 首稿前改补充 | `pack_request_changed` + `amendments_diff` + 可执行的 next_action |
| 首稿后改补充 | `amendments_after_draft`：「已有稿，改法请走 editorial feedback 记原话」 |
| 借锚点借错 | 人话拒单（哪张卡、为什么），不落盘 |
| 锚点片段没进包 | 包 ready，`warnings:["anchor_missing"]`；这一稿不讲这段亲历，宿主向创始人说明原因（原稿被删或改过） |
| 补充越界 | 写手按原要求与立意写并在交稿时说明；正文照着越界写了 → 审稿「写作补充越界」blocker |

## 6. 边界（product-sense 五问）

- **最坏输入**：空串、纯空白 → 清除；很长的补充 → 照收（与 `requirements` 一致不设上限），但长到像一份新要求时多半已经换了任务，技能文案让宿主先问一句；补充里夹带「忽略以上规则」→ 与 requirements 同一信任级（创始人原话经宿主转述），不新增注入面；外部材料仍走 `research` 的定界块。`anchor_from` 等于 `angle_id` → 视同没给，不做借用校验。
- **误用**：把受众 / 主张塞进补充 → 数据上调研读不到，语义上靠审稿与任务书可见，受众依据引不了它；拿补充指定亲历 → 补充块明写不行，要走 `anchor_from`；自拼锚点 → 接口不收锚点对象，只收卡 id。
- **失败可见**：放错口袋有专门的 code 和差异；锚点片段缺失有 `anchor_missing`；首稿后改补充有明确拒单；越界进正文有 blocker。没有静默降级。
- **双击 / 重试**：同补充重复领包同一 `pack_id`；同一 `anchor_from` 重复选卡结果相同；拒单不写盘（`select_angle` 例外，已在 §3.5 说明）。
- **刻意不做**：自动分类；自由文本指定亲历；未被锚定片段的借用；`select_angle` 收补充；时长→字数门；GUI。

## 7. 分片与上线

| 片 | 内容 | 验收 |
|---|---|---|
| A | 写作补充（§3.3、§3.4 A）+ 受众依据剔除（§3.7） | §4 A 全部 |
| B | 借锚点、候选视图露锚点、按 id 取锚点原文、引文窗口、锚点状态进写审两边（§3.2、§3.4 B） | §4 B 全部 |
| C | 放错地方的接法（§3.5、§3.4 C） | §4 C 全部 |
| D | 文案（§3.8：三处工具说明、instructions、两个技能） | 文案 diff 由创始人过目 |
| E | 行为 eval 两个场景 + 新种子 | pass^3；`post-angle-writing-choices` 若败在「选卡后到领包之间丢了补充」，再考虑让 `select_angle` 也收 `writing_amendments` 并带进 next_action |

调研侧代码只动一处：`own-material.ts` 新增一个只读函数 `loadOwnChunk`，`collectOwnMaterial` 不改，调研期行为不变。落地后 fast-forward main 并**重启 :4317**（tsx 不带 watch，不重启跑的还是旧代码）。两个技能是指向主 checkout 的软链，随 main 生效；主 checkout 未提交的 `skills/publish-content`、`skills/cover-generator` 与本次改动不重叠。落地后更新记忆「调研后别改 requirements」的 How to apply。

## 8. 待创始人确认

1. **`anchor_from` 只借本简报里别的卡已有的锚点**（推荐）。要不要扩到「调研见过、但没被任何卡锚定」的片段（`brief.ownMaterialRefs`）？机制是现成的（`loadOwnChunk` 按 id 取原文、逐字核引文），但得由宿主自己从调研材料里挑片段、摘引文，出错面更大；本次事故的「分工法」已在 angle-2 上，不扩也够用。
2. **首稿后的 feedback 挂不挂同一条边界？** 现在 feedback 可以不经调研就改受众和论点（`draft-revision.ts:80`、`revise-focus.ts:115`「未被本次要求改变的受众、论点……继续有效」）。建议在修改要求块加一句「若改受众、平台、主张或题材范围，照做前先问创作者要不要重跑调研」，只改提示词、不加门。这是对现有功能的行为改动，所以单列。
3. **首稿后不许再改 `writing_amendments`，一律走 feedback**（以正文非空判首稿）。保证每个阶段只有一个口子；代价是多一次 inspect。
4. **命名与措辞**：`writing_amendments`（你提的方向）、`anchor_from`，以及 §3.4 A2 补充块那几句写给模型的话。

## 9. codex 评审处置表（2026-09-26，codex-cli 0.153.4，medium，线程 `01a0dbef-b1b7-7df0-a82d-1881d230b7d3`；第一轮约 52 万 tokens）

codex 抽查 17 组引用，全部属实。下表每条我都回代码核过；#1 还用本次事故的写作包原文坐实（§1.8）。

| # | 级别 | 结论 | 处置 |
|---|---|---|---|
| 1 | P1 | 自由文本选不了亲历：只有卡上锚点能当亲历讲（`script-prompt.ts:407`、`generate-script.ts:344`），改写又换不了锚点 | **全采纳，方案改向**。亲历改走 `select_angle{anchor_from}` 借本简报已有锚点（§3.2）；候选视图露锚点；领包时确保锚点原文进包、缺失可见（第二轮又改了做法，见 2-2 至 2-6）；补充块明写不能换亲历 |
| 2 | P1 | 前缀追加证明不了只是写作变化；v1 默认走 writing_only 与「结构上做不到」自相矛盾 | **全采纳**。next_action 保持指向重跑（下游有确认门），两条路并列由宿主挑；`appended` 判定收紧（冻结为空、改中间、重排都不给）；§3.1、§6 改成「数据隔离不等于语义合法」 |
| 3 | P2 | 审稿受众依据拿整份 `writingContract` 比对，补充里的句子能冒充受众依据（`host-review.ts:119,136`） | **采纳前半**：冻结剔除补充块的任务文本，受众引文只比它（§3.7）。**后半记为已知限制**：正文没照写的冲突落不了审稿（schema 只收正文引文），由宿主交稿时说明 |
| 4 | P2 | 「首稿后禁改」可被合法重领绕过：force 重领把 `draft_ready` 改回 `drafting` 并清掉 `submittedAt`（`writer-prepare.ts:303-313`） | **全采纳**。改用正文非空判首稿、在写锁内判；补「交稿 → feedback → force → 再改补充」用例 |
| 5 | P2 | 已有写作包时先撞上早段 `pack_request_changed`（`writer-prepare.ts:227-238`），诊断到不了，且该分支没有 next_action | **全采纳**。任务字段变了先走 readiness（§3.4 C3）；早段拒单补可执行 next_action（含 `content_id`、空串保留）；`repackAction` 一并走 `writerPackParams` |
| 6 | P2 | `select_angle` 先落选择再检查（`workflow.ts:351-358`）；`workflow prepare` 会转给 scout，覆盖 readiness 的 next_action | **全采纳**。§3.5 写明 `select_angle` 的副作用；`selected_angle_id` 只在选择仍有效时报；scout 只给文字提示、不拼参数 |
| 7 | P2 | 并发领包缺原请求比对保护：锁外选稿读请求（`writer-prepare.ts:195-208`），发包后才认领（`writer.ts:291`） | **部分采纳**。这是现有问题，改 requirements 时同样存在，本方案不加重；现有 `pack_id` 围栏会让被作废一方的提交被拒，不会静默写错稿。首稿后拒改的判断放进写锁。并发本身另开任务（§10） |
| 8 | P2 | 稿件 `genRequest` 收稿即清（`writer-review.ts:375`），v1「持久保存在 genRequest」不成立 | **全采纳**。§1.5、§3.3 更正：原始值看包文件 `request.req`，渲染文本看 `writingContract`；补收稿、重启、feedback 重领后的找回用例 |
| 9 | P2 | 补充与 feedback、`WRITING_PRIORITY` 的优先级没闭合；feedback 能不经调研改受众 | **采纳**。§3.3 写明「feedback > 补充 > 初始 requirements，三者都不能动调研边界」；feedback 是否也挂边界属于对现有功能的改动，列 §8 第 2 条请你定 |
| 10 | P2 | 测试证明不了「调研永远看不见」：`inheritCreativeTask` 保留整份请求，`generate.ts:100-104`、`writer-pack-view.ts:93-96` 也共用续接参数 | **全采纳**。`writingContinueParams` 不改、另立 `writerPackParams`；§4 补工具入参映射、全部续接消费者、孤儿重跑、空串清除、调研期检索查询的用例 |
| 11 | P3 | 同选题多平台共享调研和选卡；选卡到领包之间会话中断，补充没地方存 | **采纳为说明**。补充按稿存不扩成选题字段；亲历经 `anchor_from` 在选卡时就落盘；篇幅口吻类仍有这一小段窗口，交给 §7 E 的 eval 决定要不要让 `select_angle` 也收补充 |

**没有驳回项。** v1 两处设计不成立（#1 亲历、#2 默认路由），一处引用对、结论错（#8 genRequest 的持久性）。

**第二轮（同一线程追问，只审 v2 新增部分；约 69 万 tokens）**，6 条全部核过：

| # | 级别 | 结论 | 处置 |
|---|---|---|---|
| 2-1 | P1 | 借 `brief_evidence` 锚点会把调研引文当成创始人的话（`angle-stage.ts:154-156` 放行、`script-prompt.ts:421` 误标），这是新入口能触发的路径 | **全采纳**。`anchor_from` 只借 transcript / approved_draft，借调研引文直接拒；补测试。原有卡自带的调研引文锚点误标仍列 §10 |
| 2-2 | P2 | 把片段钉到队首会改变截断长度，`excerptHash` 随之变化，原稿没改也会被判失配（`own-material.ts:283-299`） | **全采纳，换做法**。不再改检索排序，改为按 id 直接取锚点原文（`loadOwnChunk`）；判据改成「取得到 + 引文逐字在原文里」，不比指纹 |
| 2-3 | P2 | 取到了也可能进不了包：片段可到 4,500 字，锚点预算 2,000，超了整段丢（`own-material.ts:88,328`、`input-budget.ts:29`） | **全采纳**，并用本次 3,604 字的「分工法」转写坐实（实际写作包「口吻参考」为空，§1.8）。锚点块改为引文窗口，验收看最终写作包与审稿材料里真有引文 |
| 2-4 | P2 | 只调排序和名额钉不住：零分文档仍被跳过（`own-material.ts:275`），领包期查询不含 requirements | **全采纳**。按 id 直接取绕开相关度；只取 `brief.ownMaterialRefs` 里的 id，同选题成稿排除规则不受影响 |
| 2-5 | P2 | C3 若写成「任务字段相同才回 `pack_request_changed`」，provided / skip 模式下 readiness 就绪会落到 `reuseCurrent` 复用旧包（`writer-prepare.ts:257`） | **全采纳**。§3.4 C3 改为「先诊断，就绪后仍做完整比较」；补 provided / skip 与清空 direction 用例 |
| 2-6 | P2 | `anchor_missing` 只进了回执和锚点行，`writingContract` 与审稿输入仍按有效锚点走，写审两边会打架（`generate-script.ts:601`、`writer-review.ts:203`） | **全采纳**。锚点状态冻结进 `context.anchor`，写稿、写作约定、审稿输入三处同源；卡与卡哈希不动 |

第二轮也没有驳回项；codex 另核了「正文非空判首稿」对占位稿、未落正文的 repair、导入稿、直接修订，未发现误伤。

## 10. 顺带发现（不在本篇范围，建议另开）

- **调研引文被当成创始人的话**：`anchorLine`（`script-prompt.ts:415-422`）对 `brief_evidence` 锚点也写「这是创作者本人说过的话」；`cardView` 的 `hasAnchor`（`workflow-views.ts:72-73`）把调研引文也算成「有第一手材料」。本次 angle-1 的锚点就是 Anthropic 文章的一句，在写作包第 289 行被交代成创始人的话。
- **同选题并发领包互相作废**（codex #7）：占位稿复用在锁外、认领在发包之后，两个会话同时领包时后到的 force 会作废先到者的包。有 `pack_id` 围栏兜底，不会静默写错稿。
- **「口吻参考」块静默变空**：`renderOwnMaterial` 装不下就整段丢（`own-material.ts:328`），口吻参考预算只有 1,500 字，一段稍长的转写就让整块只剩标题。本篇只修锚点块（§3.2），口吻参考同样的问题留给另一刀。
