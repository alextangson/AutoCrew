# 设计：AutoCrew 引擎迁移到 pi AgentSession

- **日期**：2026-07-17
- **状态**：v2 已批准（创始人拍板方案 B；codex consult 评审 21 条发现全部吸收；kimi 本轮跳过）
- **决策记录**：方案 A（仅用 pi-ai 换协议层）、方案 C（不整合）被否；创始人动机 = 会话能力 + pi 生态长期对齐（AutoCrew 是 OpenClaw 插件，OpenClaw 底层即 pi）

## 背景

现状：`src/engine/loop.ts`（499 行）自研薄 agent loop —— OpenAI + Anthropic 双协议、SSE 流解析、withRetry、45s 空闲看门狗、maxTurns/token 预算、run-log —— 16 个生产模块调用。协议适配是手写硬撑：Anthropic 支持是 2026-07-08 为接 Claude 中转被迫加的，PRD §9 的国产模型矩阵还在路上，维护税只涨不跌。

目标：模型调用与会话运行时全面切换到 pi 生态（`@earendil-works/pi-coding-agent` SDK + `@earendil-works/pi-ai`），换取多 provider、持久会话、自动压缩、内建重试，并与 OpenClaw 底层同源。

非目标（本期不做）：会话分支/树导航的产品化（仅保留 JSONL 数据基础）；pi 内置 coding 工具的任何启用；`~/.pi` 生态目录的任何读写。

## §0 Spike 先行门（硬闸）

**迁移代码动工之前**，先交付一个独立 spike（`experiments/pi-spike/`，不进 src），验证以下 6 点。全过才开工；任一失败 → 停下重议方案（此时的降级不是"其余设计不变"，而是把 `pi-agent-core + pi-ai` 自组会话层写成**独立架构提案**，明确列出自建/放弃的能力清单，重新评审）。

| # | 验证点 | 对应 codex 发现 |
|---|--------|----------------|
| S1 | 锁定 pi 包版本组合（pi-coding-agent + pi-ai + peer 依赖 + Node/TypeBox 兼容矩阵），确认 SDK 当前形态（ModelRuntime vs 文档旧版 AuthStorage/ModelRegistry），版本写死进 package.json | #21 |
| S2 | 封闭 ResourceLoader：完全关闭用户/项目扩展、skills、上下文的自动发现；启动后断言 active tools 精确等于业务工具白名单，多一个即 throw | #4 |
| S3 | API key 只经内存 credential store / runtime override 注入；验证 `!`、`$` 开头的字面 key 不会被当作命令/env 表达式求值 | #5 |
| S4 | 在 pi-ai transport/fetch 层实现字节级 45s 空闲看门狗；验证中途断流 → abort → **仅重放当前 provider call**（不重跑 prompt、不重执行工具）可行 | #6 #7 |
| S5 | transport 层能记录完整 LLM I/O（含失败响应、每次重试），满足现 run-log 的数据要求；session 公开事件只承载工具/UI 事件 | #14 |
| S6 | 全部落盘限定 `<dataDir>` 内；零 `~/.pi` 读写、零更新检查、零遥测、零非模型网络请求 | #19 |

Spike 结论写回本文档"Spike 结论"一节后，才进入 §6 的迁移阶段。

## §1 依赖与安全边界

- 依赖：`@earendil-works/pi-coding-agent`（SDK：createAgentSession / defineTool / SessionManager / SettingsManager）+ `@earendil-works/pi-ai`（provider/模型层）。版本按 S1 锁死；升级永远是独立提交。
- **安全红线**：内容编辑部的 agent 不得拥有 shell / 文件系统权限。pi 内置 read/write/edit/bash 工具全部禁用；ResourceLoader 封闭（S2）；每次会话创建后运行工具白名单断言。
- **本地优先红线**：所有状态落 `<dataDir>`（默认 `~/.autocrew/`）；pi 的 agentDir/settings 全部显式指向自有路径或内存实现（S6）。

## §2 引擎 API 与会话架构

### 2.1 兼容 facade（迁移期）

`loop.ts` **不删**。保留 `runLoop(config, options)` 签名与 `LoopResult` 语义作为 facade，内部委托新引擎 `src/engine/session.ts`。16 个调用方（含 `runLoopImpl` 测试注入口）在迁移期零改动、始终可编译。全部调用方迁到新 API 后，单独提交删除 facade。

### 2.2 单任务模块（15 个）

`runTask(config, options)`：内部创建 ephemeral 会话（`SessionManager.inMemory()`），跑完即弃。返回 `{ finalMessage, turns, totalTokens, toolCallCount, stopReason }`，语义与现 `LoopResult` 逐字段一致。

### 2.3 聊天（chat-router / chat-persist）

**事实源不变**：`conversation-store`（`<dataDir>/conversations/<id>/meta.json + messages.json`）仍是唯一事实源，renderer 列表/回放不动。

**pi 会话 = 派生态**：`<dataDir>/conversations/<validated-id>/agent.jsonl`（ID 复用 conversation-store 的 `ID_RE` 正则校验，杜绝路径穿越）。派生态三定律：

1. **可重建**：agent.jsonl 丢失/损坏/尾行半写 → 静默丢弃，从 conversation-store 最近 12 条重建上下文（等价于今天的行为），坏文件改名 `.corrupt` 留证。
2. **同生命周期**：删除会话 = 删除整个 `conversations/<id>/` 目录（两处状态原子同灭）。
3. **写队列内更新**：agent.jsonl 的追加与 conversation-store 的 appendTurn 在同一 per-conversation 写队列（复用 chat-persist 现有 `enqueue`）内完成，禁止并发 prompt 同一会话。

**上下文协议**（codex #8）：system prompt 每轮按 profile/goal/platform 重建并注入（不冻结在会话头部）；view context（当前稿件等临时上下文）每轮注入、用后即清，**不进持久历史**。会话持久化的只有对话消息与工具调用记录。

**会话生命周期**：session registry 按 conversationId 缓存活跃会话；进程退出统一 `dispose()`；重新打开走"载入 agent.jsonl → 校验 → 失败即重建"路径。

### 2.4 压缩（codex #9 #10）

- 第一道防线：工具输出截断 —— `read_url` 等大输出工具单条结果截断（默认上限 8000 字符，工具定义处声明，可按工具调整）。
- 第二道防线：pi 自动压缩。前提是给每个自定义模型提供真实 `contextWindow` / `maxTokens` 元数据（映射进 §3 的 provider 定义）；reserve/keepRecent 显式配置。
- 压缩失败降级：该轮回退到"最近 12 条"窗口继续服务，不阻塞用户；失败记入 run-log。
- 压缩成本：压缩调用用当前会话模型，token 消耗记入 run-log（可观测，不隐藏）。

## §3 模型与路由

- `engine.json` 用户配置面**完全不变**（apiKey/baseUrl/protocol/strongModel/fastModel/routes）。用户零迁移。
- `loadEngineConfig` 之后新增一层映射：EngineConfig → pi-ai provider 定义（`anthropic-messages` / `openai-completions` API + 自定义 baseUrl），并补齐模型元数据（contextWindow/maxTokens，供压缩与预算使用）。
- **凭证**：key 只经内存注入（S3），绝不进任何会被解析的配置字符串。
- **协议兼容不是只换名字**（codex #15）：现 loop 固定 Anthropic `max_tokens=16000`、忽略 thinking、要求流式 usage、处理中转特有路径 —— 逐项显式映射到 pi 的 model compat 配置。每条实际 route（newcli Claude 中转为首）做**真实中转 contract test**：请求快照对比 + 真跑冒烟。

## §4 工具适配层

`defineCrewTool(loopTool)` 是一个**正式适配层**（不是 10 行糖）：

- Schema：现有 JSON Schema → TypeBox（不兼容时 `Type.Unsafe` 兜底）。
- 执行：execute 签名、返回格式（string → content blocks + details）、错误标记、取消信号（AbortSignal 透传）逐项映射。
- 执行模式：**显式串行**（同轮多工具禁止并行 —— 现有工具写 cards/effects/本地存储，并行会竞态，codex #12）。
- 测试矩阵：坏 JSON 参数、未知工具名、execute throw、取消、schema 不兼容。

## §5 行为保持（硬约束清单）

来之不易的行为一条不丢，全部有测试背书：

| 行为 | 实现位置 | 语义 |
|------|---------|------|
| 45s 空闲看门狗 | transport/fetch 层（S4） | 字节级"任何字节续命"，与现 loop 完全一致；dogfood 教训：健康长文可流数分钟，不误杀 |
| 重试 | transport 层 | 只重放当前 provider call；**写工具在任何路径下都不重复执行**（codex #7）；401 不重试、429/5xx 指数退避（沿用 pi 内建，配置对齐现 withRetry 语义） |
| 预算状态机 | session 引擎层 | 回合边界检查：完成当轮全部工具 → 下一轮请求前判断 maxTurns/maxTotalTokens → 停；允许单轮超额（与现契约一致，codex #13）；stopReason 映射：`no_tool_calls` / `max_turns` / `max_tokens` |
| run-log | transport 层记 LLM I/O（含失败/重试），session 事件层记工具事件 | 现有 run-log 文件格式不变；pi 会话 JSONL 是额外审计层，不替代 run-log |
| onEvent | session 事件转发 | `tool_start` / `tool_end` 语义不变，前端零改动 |

删除项：`withRetry`（被 pi 重试替代）、手写双协议与 SSE 解析（被 pi-ai 替代）。

## §6 迁移顺序与测试

1. **阶段 0**：Spike（§0），结论回写本文档。
2. **阶段 1**：新引擎 `session.ts` + facade 接管 `runLoop`；**`loop.test.ts`（464 行）与 `loop-runlog.test.ts` 的全部断言原样移植**（401/429、HTML 畸形 200、非数字 usage、空回复、历史顺序、Anthropic tool_result、thinking 忽略、SSE 分块与中途断流 —— 一条不挑，codex #16）。测试注入点：provider 层 fake（spike 确认注入方式，兜底本地 fake HTTP server）。
3. **阶段 2**：打样 —— 1 个单任务模块（选 `radar/relevance.ts`，有 `runLoopImpl` 注入可对拍）+ chat-router 会话化（§2.3 全套）。真实中转 contract test（§3）在此阶段跑通。
4. **阶段 3**：批量迁移其余 14 个模块到 `runTask`，逐模块提交。
5. **阶段 4**：删 facade + 死代码，收尾提交。

每阶段独立提交、可回退；`npm test` 全绿是阶段完成的定义。

## §7 风险与开放项

- **pi 迭代快、改名中**（@mariozechner → @earendil-works）：S1 锁版本；升级永远独立提交、跑全量回归。
- **双存储漂移**：被 §2.3 派生态三定律约束 —— 任何漂移的修复动作都是"删派生态重建"，永不反向。
- **压缩额外成本**：接受，记入 run-log；若实测成本显著，后续可议用 fastModel 做压缩（本期不做）。
- **降级路径**：见 §0 —— 不是"其余不变"，是独立提案重审。

## 附录：codex 评审映射（2026-07-17，consult，tokens 484,940）

9 P1 + 12 P2，全部吸收：#1→§2.1；#2→§2.3；#3→§2.3；#4→§1/S2；#5→§3/S3；#6→§5/S4；#7→§5/S4；#8→§2.3；#9→§2.4；#10→§2.4；#11→§4；#12→§4；#13→§5；#14→§5/S5；#15→§3；#16→§6；#17→§2.3；#18→非目标；#19→§1/S6；#20→§0；#21→§0/S1。原文见 codex 会话 `019f7093-c192-7ac1-8a90-2c4dad60b799`。
