# 设计：对话控制面改造（chat = 控制面，工作区 = 状态面）

- **日期**：2026-08-19
- **状态**：v3 —— 一审 NO-GO（16 P1 + 6 P2）逐条吸收后二审 17 PASS / 5 FAIL（均为 turn 生命周期簇），5 项已修入本版（见评审记录），NO-GO 条件消除
- **一句话**：总编辑对话从"挂在墙上的对讲机"升级为能驱动全链路的控制面；工作区保持结构化状态面。三阶段推进 + 一条观察中的 dsh 插件轨。

## 背景与动机

DeepSeek Harness（dsh，2026-08-13 发布）把"会话式 harness 底座"推向大众，用户心智正在被训练成"跟 agent 说话，看它干活"。诊断发现 AutoCrew 的对话面板存在四个具体病灶：

1. **默认收起**（App.tsx `dock-open` 缺省 false）——连入口都是隐藏的；
2. **只够到 ~20% 产品面**（132 IPC 通道 vs 27 chat 工具）——封面、配图、看板流转、预检、活动全是按钮才有；
3. **请求-响应式**——无 token 流式、无打断、无停止按钮；
4. **上下文单向且薄**——agent 只知道编辑器里的 contentId，不知道用户在看哪列看板。

同时仓库里 18 个 SKILL.md（Claude Code 格式）只活在 harness/插件线，GUI 对话完全不加载。**codex 一审实证**：这些技能的步骤引用的是 harness 工具协议（`autocrew_*` 工具名、`~/.autocrew/MEMORY.md` 文件读写、浏览器），与 chat 的 27 工具协议不互通——所以"能力层统一"不能靠直接复用 SKILL.md，要靠双协议改写（见 Phase 1）。

## 总原则（红线）

- **反护城河红线继续有效**（PRD-v3 §7.2 / PRD-v4 §157）：不做裸 chat 框。结构化卡片、看板、审阅面是护城河，对话是驱动它们的控制面。
- **不重启方案 B**：聊天不迁 pi AgentSession。2026-07-17 spec §7 决策记录站着——conversation-store 是唯一事实源，`runLoop`（已是 pi-ai 协议层）继续承载聊天。本设计全部改动落在 runLoop 编排层与其上。
- **不建第四套注册表**（吸收 codex #14）：现有共享点是 `execute*` / 模块函数层（chat 工具、IPC handler、插件工具最终都落到它）。Phase 2 新工具继续以 chat-router 现有模式包装该层；`registerAutocrewCapabilities` 三出口统一是独立重构提案，本设计不做、也不新建 `src/capabilities/`。
- **人审关卡保留人手点击**：发布确认、成片分句勾选、审片确认等不可逆/人审动作不给对话代办，对话只引导跳转。工具 schema 层面强制（见 move_content 白名单），不依赖 prompt 约束。
- **中止 ≠ 取消**（吸收 codex #4）："停止"只停对话编排；已投递的后台任务（封面、配图、深调研、成片）继续跑，卡片可见。UI 文案与 agent 话术都不得暗示后台任务已停。

## Phase 1：skills 进 GUI 对话（双协议改写）

### 机制

- **双协议节**：入选 GUI 的技能在 SKILL.md 增写 `## GUI` 节——保留原方法论（张力拆解、审稿框架等），但步骤只引用 chat 现有 27 工具与"引导用户去工作区面板"两类动作，**不引用** `autocrew_*` 工具、文件读写、浏览器、子代理。`read_skill`（GUI 面）只返回 frontmatter 摘要 + `## GUI` 节。
- **首批 5 个**（逐个核对过步骤所需工具都在 27 工具集内）：
  | 技能 | GUI 节映射 |
  |---|---|
  | topic-ideas | 方法论（受众张力拆解）+ find_topics / save_topic；MEMORY.md 读取 → 已由 system prompt 注入的定位/画像替代 |
  | humanizer-zh | 去 AI 味方法论 + revise_draft / revise_focus |
  | platform-rewrite | 平台腔调方法论 + adapt_platform / get_draft |
  | style-calibration | 校准流程 + absorb_style / add_style_rule |
  | content-review | 审稿框架 + audience_review / get_draft |
- **顺序修正**（吸收 codex #13）：pre-publish 依赖 Phase 2 的 pre_publish_check，移到 Phase 2 落地后再开；research（浏览器）、spawn-*（子代理）、onboarding、memory-distill、calibrate（文件读写）为 harness-only。
- **索引注入**：GUI 白名单技能的"名字 + 一句话摘要"注入 system prompt（预计 ~300 tokens，低频变化不破前缀缓存）。摘要来自 frontmatter 新增单行字段 `gui_summary`（避免解析 multiline `description: |`——见解析契约）。
- **frontmatter 解析契约**（吸收 codex P2-2）：不引 YAML 依赖。解析器只认三个**单行** `key: value` 字段：`name`、`surfaces`（逗号列表）、`gui_summary`；multiline description 一概跳过。契约写进解析器测试；skills 是仓库受控内容，格式由我们保证。
- **表面门控与安全**（吸收 codex #9）：
  - 白名单**只由** `surfaces` 含 `gui` 的终集生成；harness-only 技能 id 不进白名单，模型猜中目录名也读不到。
  - `read_skill` 从**预加载的 id → GUI 节内容 map** 返回，不用模型输入拼任何路径。
  - 加载时断言：frontmatter `name` === 目录名；realpath 在 skills/ 之内（symlink 越界拒载）。
  - **GUI 节长度是创作约束**（吸收二审 #17）：GUI 节 ≤ 6k 字符，加载时断言，超限 fail-closed 跳过该技能（中文≈1 字符 1 token，16k 字符会吃掉整轮 20k token 预算——上限必须按 token 算账定）。read_skill 输出即 GUI 节，无二次截断。
  - **单轮输入预算账**：system prompt + 定位注入 ≤ ~3k tokens，技能索引 ≤ ~300，read_skill ≤ ~6k，历史沿用现有 12 条窗口——总输入在 maxTotalTokens=20k 内留有工具结果余量。
  - 同轮内 read_skill 结果缓存，重复调用回缓存。
- **工具重名 fail-closed**（吸收 codex P2-3）：buildChatTools 出口断言工具名唯一，重名直接 throw。

### 边界与防呆

| # | 项 | 决定 |
|---|---|---|
| 状态 | skills 目录缺失/为空/无 gui 技能 | 索引不注入、不注册 read_skill，对话行为与今天完全一致 |
| 最坏输入 | read_skill 收到任意 id（含 harness-only id、路径串） | 只查 gui 白名单 map，未命中回"未知技能"；无路径拼接 |
| 最坏输入 | SKILL.md 无 GUI 节但标了 gui surface | 加载时校验失败，该技能跳过并 console 警告（fail-closed，不带病上线） |
| 失败可见 | 技能加载/读取失败 | 工具返回 `{ok:false,error}`（清洗后消息），agent 转述 |
| 有意排除 | 不做技能热重载 UI、不做用户自定义技能目录、不改 harness 面的 SKILL.md 消费方式 | |

## Phase 2：补齐对话到达面

### 新工具（chat-router 现有模式，包装既有 execute*/handler）

| 工具 | 底层 | 语义与收窄 |
|---|---|---|
| `create_cover` | cover 模块 | 异步投递 + 封面卡。**原子 per-content claim**（吸收 codex #16 + 二审 #16）：check-and-register 在同一同步 tick 内完成（任何 await 之前），claim 保持到后台任务 settle（成功/失败/同步异常），finally 释放；持有期间重复投递回"已在跑" |
| `generate_article_images` | article-images 模块 | 同上 claim 语义；`[IMAGE:]` 占位变图，投递 + 状态卡 |
| `move_content` | content transition | **目标状态白名单**（吸收 codex #11）：只允许 灵感库↔在写↔待审 之间的边；待发布/已发布 相关边一律不暴露（schema enum 层面），不依赖状态机兜底 |
| `pre_publish_check` | publish digest | 发布前检查报告卡（敏感词/状态/封面/配图），只读 |
| `list_campaigns` / `campaign_status` | campaign 模块 | 只读 |
| `list_inbox` / `retry_inbox` | inbox 模块 | 查询 + 重试（重试幂等由后端既有语义保证） |
| `list_versions` | content versions | 只读；revert 不进对话 |

- CREW_TOOL_STATUS 为每个新工具补角色署名与人话标签。
- **错误清洗**（吸收 codex P2-4）：给 agent/用户的错误是稳定语义 + 清洗后消息（剥本地绝对路径、provider 内部细节）；原始错误只进 run-log。"不篡改语义"保留——禁止把失败包装成成功话术。

### 工作区动作 → 模型上下文（trace 降级重设计，吸收 codex #15）

- **不插会话、不做 UI 展示**。工作区关键动作（流转、封面定稿、发布确认、成片确认）写入 `~/.autocrew/recent-actions.json` **有界环**（最多 20 条，覆盖写，无整文件增长）。
- 下一轮 chat:turn 服务端注入最近 5 条 / 30 分钟窗内动作摘要到模型上下文（只进模型，不进持久历史——沿用 §C1 规则；token 上限 ~300）。
- 会话内可见的动作叙事流需要 conversation-store 契约扩展，**另立提案**——本期有意排除，避免串会话/刷新即失/绕存储三个坑。
- 环写入失败不阻塞动作本身（观测层不破坏执行层，console 记录）。

### 边界与防呆

| # | 项 | 决定 |
|---|---|---|
| 状态 | 异步任务投递后 | 卡片即回执；agent 明说"已派下去，进度看卡"（deep_research 先例） |
| 最坏输入 | move_content 收到白名单外状态 | schema enum 拒绝（模型侧就看不到该选项）；后端状态机是第二道防线 |
| 防呆 | 同一动作双发 | claim 互斥回"已在跑"；用户视角无重复任务 |
| 失败可见 | 任何底层拒绝 | 清洗后错误进对话，agent 转述原因 |
| 有意排除 | campaign 创建、revert/delete/trash、video cut/review 确认、会话内动作叙事流 | |

## Phase 3：对话存在感（流式 / 可打断 / 常驻 / 双向上下文）

### turn 寻址与中止链路（吸收 codex #1 #2 #3 #8）

- **turnId 客户端生成**（uuid），随 `chat:turn` 传入，同时传**clientId**（每标签页随机生成、会话期驻内存）。服务端**活跃 turn 注册表**：turnId → { AbortController, clientId, conversationId?, status, startedAt }。
- **turn 身份与归属**（吸收二审 #1 #新3）：`chat:abort {turnId, clientId}` 必须 clientId 匹配才生效（另一标签页不能中止/冒用）；`chat:turn` 收到与活跃条目重复的 turnId 直接 409 拒绝。所有请求本就带 server-token（本地单用户鉴权面），clientId 解决的是标签页间命名空间。
- **abort settle 语义**（吸收二审 #新1）：`chat:abort` 触发 controller.abort() 后返回 `{ok:true, settling:true}`；注册表条目**保持 busy 直到原 chat:turn settle** 才转 done。settle 前同 conversation/client 再发 turn → 409"上一轮正在停止"。UI 停止按钮变"正在停…"，以 invoke 返回解锁输入。
- 未命中注册表的 abort（已完成/未知）幂等返回 `{ok:true, already:"done"}`。
- **信号贯通**：`LoopOptions.signal` 新增；`registerExchange` 接受外部 signal 并接到 observer 的 AbortController（exchange.release 只删路由的现状不变，中止走 signal）；`withRetry` 识别用户中止错误类：**signal.aborted 的失败不重试**。
- **中止的返回路径**（吸收二审 #8）：用户中止**不走 throw 出口**——runLoop 捕获 signal.aborted 的失败，正常返回 `LoopResult{stopReason:"aborted", finalMessage: 已有的最后一段助手文本或空}`；runChatTurn 照常 `ok:true` 返回 + stopReason 透传，chat-persist 按正常轮持久化（不写失败轮）。
- **工具边界语义**（不宣称原子）：abort 检查点 = 每次模型调用前、**每个工具执行之间**。已开始的工具跑完（写工具单步落盘或单次投递，是现有 execute* 层的既有形态）；同一响应里剩余未执行的工具跳过。
- `visibleChatReply` 增 aborted 分支：有卡片 →"已停，以下是已完成的部分"，无卡片 →"已停"。**修掉现有兜底在中止场景下的"任务已完成"误报**。

### 流式 delta 协议（吸收 codex #5 #7）

- SSE 事件：`{kind:"chat_delta", turnId, seq, ev: "delta"|"reset"|"done", text?}`。
  - `delta`：assistant 文本增量（pi-wire 流事件透出，含多 assistant 轮的每轮文本）。
  - `reset`：withRetry 发起新 attempt 时发出——UI 清空当前 turn 气泡重来（解决失败 attempt 已发 delta 的重复/改写）。
  - `done`：本 turn 流结束提示（UI 可显示"整理回复中"，等待 invoke 响应）。
- **事实源不变**：`invoke("chat:turn")` 完整返回是唯一事实源，到达后**全量覆盖** delta 累积（多轮文本拼接差异以响应为准）。
- ChatDock **按 turnId 过滤**：只渲染本标签页发起的活跃 turnId 的事件；其他标签页/旧 turn 的广播事件丢弃。

### 断线恢复契约（吸收 codex #6）

- turn 结果在服务端落 conversation-store（chat-persist 现有路径），与客户端是否在线无关。**assistant 消息记录增持久化 `turnId` 字段**（吸收二审 #6 #新2，additive 扩展，纳入现有 append 契约；旧记录无此字段照常读）。
- **turn 索引**：`~/.autocrew/recent-turns.json` 有界环（50 条，turnId → {conversationId, at}），turn settle 时写入——服务端重启后 done 判定不靠内存注册表。
- 新增只读查询 `chat:turn_status {turnId}` → `{status: running|done|unknown, conversationId?}`：先查活跃注册表（running），再查 turn 索引（done + conversationId，**首轮响应丢失也能拿到 conversationId 去 refetch**），都未命中为 unknown。
- ChatDock 挂载/SSE 重连时：重载会话 + 若本地记着未完成 turnId 则查 turn_status——`done` 则按返回的 conversationId refetch 补上结果，`running` 则显示"上一轮还在跑"，`unknown` 则提示该轮结果丢失可重发。

### 常驻与上下文

- dock 缺省翻转为**默认展开**；已有 localStorage 值的老用户不被覆盖（只改缺省分支）。用户手动收起继续记忆；revision focus 自动展开保留。宽度 360 固定 → 可拖拽 320–560px，记忆。
- viewContext 扩展：`{route, contentId?, boardColumn?, campaignId?}` + recent-actions 注入（Phase 2）。**服务端校验**（吸收 codex P2-6）：route/boardColumn 走枚举白名单，campaignId 做存在性查询，非法字段丢弃不进 prompt（contentId 现有校验保留）。
- 卡片加"在工作区打开"动作：topic→看板定位、draft→编辑器、cover→封面面板、video_kit→成片卡（revision_proposal 深链先例推广）。

### 边界与防呆

| # | 项 | 决定 |
|---|---|---|
| 状态 | SSE 断线中 turn 完成 | invoke 响应或恢复契约兜底，无缝 |
| 状态 | 服务端重启丢活跃注册表 | turn_status 回 unknown，UI 提示可重发；不假装还在跑 |
| 防呆 | 停止连点 / abort 已完成 turn | 幂等，`already:"done"` |
| 防呆 | abort 后立即再发言 | 上一轮资源已释放（exchange release / 注册表清理），新 turn 正常起 |
| 失败可见 | abort 时有工具已执行 | 卡片保留 + "已停，以下是已完成的部分"；后台任务明示继续跑 |
| 有意排除 | 多 turn 并行（进行中禁再发）、dock 左右位置切换、会话分支 | |

## dsh 插件轨（观察，本期零代码）

- dsh 发布 6 天、developer preview、官方声明必有破坏性变更——现在写适配层是给别人交学费。
- **触发条件**（满足其一再开 spike）：dsh 插件 API 出 stable tag；或连续两个月度版本无插件接口破坏性变更。
- 届时形态：薄适配包（npm，`dsh-plugin` topic）+ skills/ 目录直挂 + `~/.autocrew/` 共享状态；GUI 面吸收 codex #10 的教训——若届时暴露粗粒度 `autocrew_*` 工具需按 surface 做 action 级收窄，不能只白名单工具名。

## 测试

- P1：read_skill 白名单（harness-only id 拒绝）/ symlink 越界拒载 / name≠目录名拒载 / 无 GUI 节 fail-closed / 16k 截断 / 同轮缓存 / 失败路径；索引注入 golden（确定性内容）；工具重名断言；带 fake 引擎的 loop 集成。
- P2：新工具 happy + fail（清洗后错误语义断言）；move_content enum 白名单（发布边不存在）；cover/配图 claim 竞态（并发双投递只起一个）；recent-actions 环上限与失败不阻塞。
- P3：abort 幂等 / 用户中止不重试 / 工具间中止跳过剩余工具 / stopReason=aborted 全链 / visibleChatReply aborted 分支；delta reset 语义；turnId 过滤（异 turn 事件丢弃）；turn_status 三态；dock 缺省态迁移（老 localStorage 不覆盖）。
- 全程遵守：不对 LLM 文本精确断言，只断不变量与 schema。

## 迁移与提交切分

1. P1 独立提交系列（frontmatter 契约 + 解析 → 5 技能 GUI 节改写 → read_skill 工具 + 门控），落地后 dogfood 一轮再进 P2。
2. P2 按工具组切提交（封面配图 claim / 流转预检 / 只读查询 / recent-actions 环）。
3. P3 三块独立：中止链路（含 turnId 注册表）、流式 delta、常驻+上下文。
4. 每阶段完成后回写本文档落地记录。

## 非目标汇总

- 不重启 AgentSession（2026-07-17 §7 决策记录）
- 不重构既有 27 工具 schema、不建第四套能力注册表（三出口统一另立提案）
- 对话不获得破坏性能力（revert/delete/trash）与发布边流转
- 人审关卡不代办
- 会话内动作叙事流（trace UI）另立提案
- dsh 适配本期零代码
- 不做多 turn 并行、会话分支、自动压缩

## 落地记录

- **Phase 1 ✅（2026-08-19）**：skills-reader 单行 frontmatter 契约 + `listGuiSkills()` 六道 fail-closed 门控（harness-only 不入选、name≠目录名、symlink 越界、无/空 GUI 节、>6000 字符、缺 gui_summary）；chat-router 注入技能索引 + `read_skill`（预加载白名单、同轮缓存、40 字符 id 回显截断）+ 工具重名 throw；5 技能双协议改写（GUI 节 947–1426 字符）。新增 27 测试，全仓 2187 passed，tsc 干净。既有 27 条 chat-router 测试零改动通过。偏离：harness-only 跳过不 warn（13 个技能的启动噪音）；缺 gui_summary 增补为第六道门。
- **Phase 1 dogfood ✅（2026-08-19）**：真实引擎（~/.autocrew 生产配置）跑 runChatTurn，输入"帮我想想「AI 帮小团队干活」…"：工具序列 `["read_skill"]`，回复按 topic-ideas GUI 节的受众张力方法论展开（张力 A-D 结构），turn 正常收尾、无意外写入。闸门通过，进 Phase 2。
- **Phase 2 ✅（2026-08-19）**：九个到达面工具（create_cover / generate_article_images / move_content / pre_publish_check / list_campaigns / campaign_status / list_inbox / retry_inbox / list_versions）落在新文件 `chat-tools-workspace.ts`（chat-router 已 1161 行，不再塞）；`job-claims.ts` 同步 tick check-and-register + 持有到 settle；`error-clean.ts` 剥绝对路径与堆栈、语义不改；`recent-actions.ts` 20 条有界环 + 30 分钟/5 条注入（挂 content:transition、cover approve、publish:confirm、video cut/review confirm 四处成功路径）；move_content enum 只有 draft_ready/revision/reviewing，发布边在 schema 层不存在；pre_publish_check 用 `_readOnly` 压住 pre-publish 的 auto-transition（否则"只读检查"会把稿推过待发布关卡）。新增 38 测试，src/desktop 382 → 420，全仓 2228 passed，tsc 干净，frontend build 通过。偏离：新增 `startArticleImagesJob`（暴露 completion 句柄，镜像 cover 的 StartedCoverJob，行为不变）；RecentAction 多一个可选 `detail`（流转要说清挪到哪列）；灵感库列在稿件侧没有对应状态（那列是选题），白名单实际落在在写/待审两列。
- **Phase 3-1 ✅（2026-08-19）中止链路与断线恢复**（流式 delta / dock 常驻 / viewContext / 卡片深链留给后两块）：新增 `turn-registry.ts`（活跃 Map + `recent-turns.json` 50 条有界环）——重复 turnId 拒、(turnId, clientId) 归属校验、abort 后转 stopping 且 busy 到原 turn settle、settle 写环并清条目（写失败只 warn）；通道加 `chat:abort`（命中 `{ok:true,settling:true}` / 未命中 `{ok:true,already:"done"}` / 归属不符明确拒）与 `chat:turn_status`（running→环 done→unknown 三态）；`chat:turn` 的 turn_id/client_id 是可选 additive 扩展，老前端不传则不登记、不可中止、行为不变。信号贯通 `LoopOptions.signal` → observer（外部 signal 接内部 AbortController，监听器 finally 摘除）→ `withRetry`（signal.aborted 的失败不重试）；检查点 = 每次模型调用前 + 每个工具执行之间。中止走正常出口：`LoopResult.stopReason="aborted"`（finalMessage 为已有助手文本或空串）→ runChatTurn `ok:true` + stopReason 透传 → chat-persist 按正常轮落盘（assistant 消息增可选 `turnId`，additive）→ `visibleChatReply` 的 aborted 分支排在其它兜底之前，修掉「任务已完成」误报。前端：模块级 clientId + 每轮 turnId、进行中「停止 → 正在停…」以 invoke 返回解锁、aborted 回复附「后台任务继续跑」一行、挂载/SSE reconnect 查 turn_status 三态恢复（running 每 3s 轮询到收尾）。新增 44 测试（turn-registry 13 / chat:turn 控制面全链 10 / loop 中止 4 / withRetry 2 / chat-router 2 / chat-persist 2 / 前端 turn-recovery 11），src/desktop+src/engine 487 passed，全仓 2270 passed，tsc 干净，frontend build 通过。偏离：① 中止且已有助手文本时保留原文（「已停，以下是已完成的部分」只做兜底文案，避免丢掉模型已说的话）；② 归属不符的 abort 返回 `{ok:false,error}` 而非幂等 done——不代别的标签页做主，也不谎报已完成；③ 恢复判定抽到 `frontend/src/chat/turn-recovery.ts` 纯模块（前端测试基建只跑 node 环境的 .test.ts，组件本身无法单测）；④ running 态加了 3s 轮询（否则「上一轮还在跑」是个永远不会自己消失的死胡同）。
- **Phase 3-2 ✅（2026-08-19）流式 delta 协议**（dock 常驻 / viewContext / 卡片深链留给第三块）：引擎侧 `consumePiStream(s, onTextDelta?)` 透出 pi-ai `text_delta`（thinking / toolcall 参数不透），`LoopOptions.onTextDelta` 收 `{ev:"delta",text} | {ev:"reset"}`——**reset 发在 withRetry 的每次 attempt 开头**（事务边界 = 一次完整流消费，失败 attempt 与工具往返的上一轮文本一起作废，UI 不会「同一段话说两遍」）；回调异常两层都吞（观测层不破坏执行层）。协议层：`runChatTurn.onDelta` 透传 reset/delta，loop 收尾（成功/中止/失败都算）在 finally 补 `done`；chatTurnHandler 持 per-turn 计数器补 `{turnId, seq}`，经新增的 `IpcHandlerContext.onChatDelta` → server `broadcast("chat_delta", …)`，与工具进度共用 SSE 连接但事件名分开（进度条不被正文污染）；**没有 turn_id 的调用一帧都不发**（不可寻址的 delta 前端无从判断该不该渲染，老前端零行为变化）。前端新增纯模块 `frontend/src/chat/delta-stream.ts`：异 turnId 丢弃、`seq <= 已见` 丢弃（重复/乱序都当迟到帧）、reset 清空并退回 done、无关帧返回同一引用（免重渲染）；ChatDock 用同一套 markdown 渲染流式气泡（无打字机动画），invoke 返回处 `clearStream()` + 响应全量覆盖，`done` 期间显示「整理回复中…」，停止按钮与流式共存。新增 23 测试（loop-delta 5 / chat-delta 全链 4 / delta-stream 14），src/desktop+src/engine+frontend/src/chat 499 → 522，全仓 2293 passed，tsc 干净，frontend build 通过。偏离：① reset 的粒度是「每次模型调用」而非「仅重试」——工具往返的新一轮也 reset，这样流式气泡收敛到最后一轮文本，与 `finalMessage`（最后一段助手文本）天然对齐，否则全量覆盖时会看到内容凭空缩短；② 多轮文本仍**逐轮都透出**（spec 要求），只是屏幕上不叠加；③ 引擎语义（增量/重试 reset/多轮）断在 `loop-delta.test.ts`（真 pi-ai 解析 + 真观察器、可注入 fetchImpl 与假工具），广播协议（turnId/seq/done/无 turnId 不发）断在 `chat-delta.test.ts` 真链路——两处合起来覆盖任务清单，不在真链路里重造工具往返夹具。
- **Phase 3-3 ✅（2026-08-19）常驻与双向上下文**（Phase 3 收官）：dock 缺省翻转为展开——迁移语义收进新纯模块 `frontend/src/chat/dock-prefs.ts`，`readDockOpen` 只有显式存过 `"0"`（手动收起过）才收起，没存过=展开，老用户的表态一个都不覆盖；宽度 360 固定 → 左缘 `.dock-resizer` 指针拖拽 320–560px（clamp 在纯模块里，坏值/空串回 360），双击回默认，值经 `--dock-w` 内联变量下发（窄屏媒体查询照旧覆盖成整宽），`.main` 补 `min-width:0` 让主区让位而不是撑出横向滚动条。viewContext：前端 `frontend/src/chat/view-context.ts` 组装 `{content_id?, revision_focus?, route, campaign_id?}`（修改焦点的稿件优先于当前打开的稿件）；服务端新文件 `src/desktop/chat-view-context.ts` 收下全部校验——route/boardColumn 走枚举白名单、campaignId 走 `getCampaign` 存在性查询（顺带取名字进注入行）、看板列脱离 board 视图即丢、非法字段静默丢弃且一个字不进 prompt；`ChatViewContext` 类型迁到该文件，chat-router 只做 `export type` 转出口，ipc.ts 的 30 行内联解析塌成一行 `parseViewContext`。注入行拼在既有【当前上下文】块里（编辑器路由+有稿件时不重复报位置），system prompt 未动。卡片深链：`ChatCard` 收 `nav`（= 壳的 setRoute，与 Dashboard/Inbox 同一套 house pattern），draft/pre_publish→编辑器、cover_job/article_images_job/video_kit→编辑器的封面/配图/成片面板（Route 的 editor 分支加可选 `panel`，Editor 按它展开对应 `<details>` 并 `scrollIntoView`，滚两次以等异步面板内容落位）、topic/topic_saved/content_moved→看板；顺带补了 `drafts_list`（原本 JSON 兜底）与 `topic_saved` 两张卡的正式渲染，前者每行直接开编辑器。新增 32 测试（服务端 chat-view-context 15 / 前端 dock-prefs 10 + view-context 7），src/desktop+src/engine+frontend/src/chat 522 → 554，全仓 2325 passed，tsc 干净，frontend build 通过。真机烟测（临时 AUTOCREW_DATA_DIR + 本地 server + 浏览器）：无 localStorage 时 dock 默认展开、存 `"0"` 的老用户刷新后仍收起；拖拽 360→480→夹到 560→双击回 360 且均落 localStorage；board 视图发言实发 `context:{route:"board"}`、campaigns 视图带 `campaign_id`、离开该视图后不再带；封面/配图深链真的展开面板并滚到位，稿件列表行与「去看板」落点正确。偏离：① **boardColumn 前端无产出方**——Board.tsx 没有"聚焦列"这个概念（只有瞬时 dragOver 与矩阵模式），不硬造 UI 状态，字段的白名单校验按 P2-6 落地并单测，产出方留给真需要时再加；② 深链滚动用即时定位而非 `behavior:"smooth"`（烟测环境里平滑滚动整段丢失，深链的语义是"带我去那儿"，不欠一个动画）；③ 封面面板的展开态不进 localStorage（保持"每次进来默认折叠"的既有行为，只有深链才自动展开），配图面板沿用既有记忆；④ 同一深链连点两次（route 值不变）不会重新展开/滚动，需先切走再回来——权衡后不引入 nonce。
- **Bugfix ✅（2026-08-20）修改焦点退不出去的死循环**（真机 dogfood）：**现象**——锁了焦点后提超出焦点范围的要求，总编辑答「去编辑器点空白处取消选区，然后回『好了』」，用户照做焦点仍在，模型继续拒绝，来回死循环。**根因**三条：① 焦点只有 `clearFocus()` 能清（`frontend/src/revision.ts` 模块级 store），点编辑器空白处根本无效，而 system prompt 3.5 既没说真实退出机制、也没给模型退出的手段，于是它编了一个；② 编辑器侧「退出修改」按钮只在 `activeProposal` 块里渲染，没出提案时编辑器里无路可退（ChatDock 那条 × 用户没找到）；③ 焦点全局持久，切稿件/离开编辑器都不清，过期焦点持续劫持后续 turn。**修法**四件：新增 chat 工具 `clear_revision_focus`（署名 writer「编剧退出修改模式」，推 `focus_cleared` 卡 + 回执告诉模型同轮可接着用常规工具；服务端 `revisionFocus` 改为本轮可变，退出后同一轮 `revise_draft` 立刻放行）；prompt 加 3.6 规则（要求超出焦点范围或用户说取消时**自己调工具退出**、同轮把事办完，禁止让用户去编辑器操作再回来说「好了」，真实手动出口只当被问起时提）；Editor 在有焦点无提案时渲染一条窄条 + 「退出修改」；焦点生命周期绑定编辑器（卸载/切稿件时清掉属于本稿的焦点）。两处收紧：卸载清焦点**仅在无未收下提案时**（"拿到提案→回看板瞄一眼→回来收下"不能丢提案，劫持风险由其余三个修复兜住）；无焦点误调 `clear_revision_focus` 回 ok 但不推卡（不给用户看空回执）。新增 5 测试（`revise-focus-tool.test.ts`），全仓 2330 passed，tsc 干净，frontend build 通过。
- 预存在问题（非本期引入）：src/desktop/ipc.test.ts 第 39 行 describe 未闭合导致整文件 0 测试执行（已开独立修复任务）；src/desktop/inbox-handlers.test.ts「attempts 超限项被重跑」与 research-runtime.test.ts「四拍进度」在全仓并发下偶发超时（单独跑稳定通过）。

## 评审记录

**codex 一审**（2026-08-19，session `01a01977-00b6-7af0`，tokens 1,425,325）：NO-GO，16 P1 + 6 P2。吸收对照：

| # | 发现 | 吸收 |
|---|---|---|
| 1 | abort 无可寻址目标 | turnId 客户端生成 + 活跃 turn 注册表 + 归属校验 |
| 2 | observer 不接外部 abort；withRetry 会重放中止 | LoopOptions.signal 贯通 observer；withRetry 识别用户中止不重试 |
| 3 | 不传 signal ≠ 工具原子 | 改为"工具边界语义"：工具间检查点 + 剩余工具跳过，不宣称原子 |
| 4 | 后台任务与 abort 语义冲突 | 总原则新增"中止 ≠ 取消"；文案明示后台任务继续 |
| 5 | delta 无 attempt/多轮语义 | delta 协议增 seq + reset + done；响应全量覆盖 |
| 6 | 聊天线无重连恢复 | 断线恢复契约：turn_status 查询 + 三态处理 |
| 7 | ChatDock 不按 runId 过滤 | 按 turnId 过滤，异 turn 丢弃 |
| 8 | aborted 无端到端契约 | stopReason=aborted 全链 + visibleChatReply 分支修误报 |
| 9 | read_skill 白名单可绕过 surfaces | 白名单只由 gui 终集生成 + 预加载 map + realpath/name 断言 |
| 10 | 工具名白名单不足以限能力 | GUI 只用 action 级窄工具（本期不暴露 autocrew_*）；记入 dsh 轨 |
| 11 | move_content 违反人审红线 | 目标状态 enum 白名单，发布边不暴露 |
| 12 | 首批技能实际不兼容 | 双协议改写：GUI 节只引用 chat 工具；read_skill 只返回 GUI 节 |
| 13 | Phase 1/2 顺序矛盾 | pre-publish 移 P2 后；首批只留 27 工具可承载的 5 个 |
| 14 | 三出口共享会成第四套 | 砍 src/capabilities/；沿用 execute* 共享层；统一另立提案 |
| 15 | trace 插会话不安全 | 降级为服务端上下文注入（有界环）；会话叙事流另立提案 |
| 16 | 封面查询后创建竞态 | 原子 per-content claim |
| P2-1 | 64KB 是字符且无 token 上限 | read_skill 输出上限 16k 字符 |
| P2-2 | frontmatter 解析依赖未决 | 单行字段契约（name/surfaces/gui_summary），不引 YAML |
| P2-3 | 工具重名静默覆盖 | buildChatTools 出口断言唯一，重名 throw |
| P2-4 | 错误原样透传泄露 | 清洗后消息给用户，原始进 run-log |
| P2-5 | recent trace 无范围定义 | 环 20 条上限 / 注入 5 条 / 30 分钟窗 / token 上限 |
| P2-6 | viewContext 新字段无服务端校验 | 枚举白名单 + 存在性校验，非法丢弃 |

**codex 二审**（同会话，tokens 1,559,246）：17 PASS / 5 FAIL + 2 新 P1，初判 NO-GO。FAIL 项全部修入 v3：

| 二审项 | 发现 | v3 修法 |
|---|---|---|
| #1 + 新3 | turn 归属无可执行依据；turnId 无命名空间 | clientId 每标签页随机生成，abort 须 (turnId, clientId) 匹配；活跃重复 turnId 409 拒绝 |
| #6 + 新2 | turn_status 查不到 done；首轮无 conversationId 可 refetch | assistant 消息持久化 turnId（additive）；recent-turns.json 有界环索引；turn_status(done) 返回 conversationId |
| #8 | 中止被当失败轮 | runLoop 捕获用户中止正常返回 stopReason=aborted；chat-persist 按正常轮落盘 |
| 新1 | abort 后立即再发言与收尾工具并行 | 注册表 busy 到原 turn settle；settle 前再发 409；UI"正在停…"以 invoke 返回解锁 |
| #16 | claim 生命周期未定义 | 同步 tick 内 check-and-register；claim 持有到任务 settle，finally 释放 |
| #17 | 16k 字符非 token 预算 | GUI 节 ≤ 6k 字符创作约束 + fail-closed 断言 + 单轮输入预算账 |

NO-GO 条件消除。终稿。
