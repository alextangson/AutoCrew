# 设计：AutoCrew 引擎协议层迁移到 pi-ai（方案 A）

- **日期**：2026-07-17
- **状态**：v3 —— 方案 B（全换 AgentSession）经 codex 评审后创始人回退到方案 A；决策记录见 §7
- **一句话**：`loop.ts` 保留全部编排逻辑，只把手写的双协议 + SSE 解析换成 `@earendil-works/pi-ai`；16 个调用方零改动

## 背景

现状：`src/engine/loop.ts`（499 行）自研薄 agent loop，16 个生产模块调用。痛点集中在协议适配层：OpenAI + Anthropic 双协议是手写硬撑（Anthropic 是 2026-07-08 为接 Claude 中转被迫加的），SSE 流解析、usage 提取、畸形响应处理全部自维护；PRD §9 的国产模型矩阵还在路上，这条路的维护税只涨不跌。

目标：协议层交给 pi-ai（多 provider、自定义 baseUrl、统一流式接口、usage/成本内建），编排层（预算、看门狗、run-log、onEvent、工具串行执行）原封不动。同时踩上 pi 生态的地基 —— pi-ai 即 OpenClaw 底层栈的模型层。

非目标（本期不做）：
- AgentSession / 会话持久化 / 自动压缩 / 分支（方案 B，已完整评审后暂缓，见 §7）
- 聊天架构改动：`conversation-store` / `chat-persist` / 12 条窗口全部不动
- pi-coding-agent SDK 的任何部分（ResourceLoader、内置工具、SettingsManager 均不引入）

## §0 Mini-spike 先行门

动工前在 `experiments/pi-spike/` 验证 4 点（比 B 的 6 点门小，但同样是硬闸）。任一失败 → 停下重议。

| # | 验证点 | 承接 codex 发现 |
|---|--------|----------------|
| A1 | 锁定 `@earendil-works/pi-ai` 版本 + TypeBox peer + Node 兼容矩阵，写死进 package.json | #21 |
| A2 | key 程序化注入安全：直接构造 Model/provider 对象传入内存 key，验证 `!`、`$` 开头字面 key 不被求值 | #5 |
| A3 | **自定义 fetch/transport 注入可行且 per-call**（A 的最大单点验证项）：字节级 45s 看门狗、run-log 完整 LLM I/O（含失败响应与每次重试）、测试 fake 三件事都挂在这一个注入点上。必须 per-call 注入并通过并发隔离验证（多调用方并发时 watchdog/日志/fake 互不串扰），禁止改写 `globalThis.fetch`。**无软兜底**：注入不可行 = spike 失败 → 停下重议方案 | #6 #14 |
| A4 | anthropic-messages + 自定义 baseUrl 真打 newcli 中转冒烟；compat 逐项核对：`max_tokens=16000`、thinking 忽略、流式 usage、中转特有路径 | #15 |

Spike 结论以"Spike 结论"一节回写本文档后，进入 §5 迁移。

## Spike 结论（2026-07-17，experiments/pi-spike/）

| 门 | 判定 | 证据 |
|----|------|------|
| A1 | **PASS** | `@earendil-works/pi-ai@0.80.10` 精确锁定；Node 26.5 ≥ 要求的 22.19；typebox 1.1.38 是其直接依赖（无 peer 负担）；ESM 兼容 |
| A2 | **PASS** | `!echo hacked`、`$HOME-literal` 等危险字面 key 经 `options.apiKey` 原样落 `x-api-key` 头、零求值（a2-key-safety.mts 三例全过）。codex #5 的求值风险在 pi-coding-agent 的配置解析器，本方案不经过它 |
| A3 | **PASS（机制替换，见下）** | 环回观察器三场景全过（a3-watchdog.mts）：正常流零损耗；断流 1.9s 内 idle_kill + SDK 报错不挂死；并发一活一死互不误伤 |
| A4 | **PASS** | 真实 newcli 中转（路径前缀 baseUrl）经观察器冒烟：200、流式文本、usage 完整（input/output/cacheRead/cacheWrite/totalTokens）、onPayload/onResponse 触发、观察器录到双向字节（a4-real-smoke.mts） |
| A5 | **PASS**（阶段 2 补验） | 生产 `runLoop`（pi-ai 引擎）→ 观察器 → 真实 newcli，带工具往返：tool_use → tool_result → 终答含工具结果；`eager_input_streaming` 附加字段真 relay 接受（a5-e2e-smoke.mts，2026-07-18） |

**A3 机制替换声明**：pi-ai 0.80.10 **没有** per-call fetch/transport 注入点（`StreamOptions` 无 fetch 字段；anthropic-messages/openai-completions 直接 `new Anthropic/OpenAI({baseURL})`，内部代理工具只接 codex-responses 与 bedrock 两路）。按字面，原 A3 表述该判失败；但门的四项**要求**全部由"进程内环回反向观察器"达成：SDK → `http://127.0.0.1:<port>/t/<token>/…` → 明文转发真实上游。per-call（token 路径段）✓ 并发隔离（per-exchange 计时）✓ 不碰 `globalThis.fetch` ✓ 字节级看门狗（含首字节等待）✓。观察器同时就是测试 fake 的注入点（测试把 baseUrl 指向 fake 中转即可，等价旧 fetchImpl）。观察器只做传输与计时，不解析不落盘。

**run-log 范围修正**（利好）：核对 run-log.ts 真实字段（messages 进/出 JSON、tokens、错误串、16k 截断、脱敏）—— `onPayload`（请求侧）+ 最终 AssistantMessage/error 事件（响应侧）即可完整满足，**不需要**原始 HTTP I/O。codex #14 按"完整请求体+失败响应+每次重试"评估偏严；每次重试的记录由我们自己的 withRetry 落，天然覆盖。观察器只承担看门狗。

**实现须知**（spike 学到的）：SDK 内建重试默认 2 次，必须显式 `maxRetries: 0`（避免双重重试）；pi-ai 错误走 `error` **事件**而非 throw，withRetry 按事件分类；URL 拼法与现 loop 相同（anthropic `+/v1/messages`、openai `+/chat/completions`），路径前缀 baseUrl 原生兼容。

## §1 依赖

仅 `@earendil-works/pi-ai`（root entrypoint，core-only、side-effect free —— A1 复核"零 `~/.pi` 读写、零遥测"）。不引入 pi-coding-agent / pi-agent-core。版本升级永远是独立提交。

## §2 引擎改动

`loop.ts` 对外 API（`runLoop` / `LoopOptions` / `LoopResult` / `LoopTool`）与编排逻辑**不变**：

- **换掉**（约 300 行）：双协议请求构造、SSE 解析、usage 提取 → `models.stream(model, context)` 事件流。
- **保留**：maxTurns / maxTotalTokens 预算状态机（回合边界检查、允许单轮超额）、stopReason 语义、history 注入、onEvent 转发、**工具由 loop 自己串行执行**（pi-ai 只解析出 tool call，不执行 —— 串行/预算/cards 语义天然不变）。
- **保留 `withRetry`**：401 不重试 / 429 与 5xx 指数退避的现有语义逐字保留。重试全权归我们：若 A1 发现 pi-ai 有内建重试则显式关闭，避免双重重试。**重试事务边界**：重试单位 = 一次完整的流式消费（从发起 `models.stream()` 到事件流正常收尾），不是只包创建调用 —— 中途断流是该次尝试的可重试失败；每次尝试的增量内容缓存在 attempt 本地，流成功收尾后才提交消息与 tool call；写工具在任何路径下不重复执行。
- **看门狗**：字节级 45s 空闲超时移到 A3 的 fetch 注入层；"任何字节续命、健康长文不误杀"语义不变。
- **run-log**：数据源从手写 HTTP 层改为 A3 注入层捕获（含失败响应与每次重试），落盘格式不变。

工具映射：`LoopTool` 的 JSON Schema → pi-ai Tool（TypeBox；不兼容时 `Type.Unsafe` 兜底）。适配器覆盖测试：坏 JSON 参数、未知工具名、schema 不兼容。（承接 #11）

## §3 配置映射

`engine.json` 用户配置面**完全不变**。`loadEngineConfig` 后新增纯函数映射：EngineConfig → pi-ai Model 对象（`api: anthropic-messages | openai-completions`、自定义 baseUrl、内存 key、contextWindow/maxTokens 元数据）。routes（writer/analytics/scout/codex）逐条映射，语义不变。

模型元数据来源（EngineConfig 本身没有这些字段）：内置元数据表覆盖预设与常用模型；未知模型走保守默认 `contextWindow=131072`、`maxTokens=16000`（后者与现 loop 固定值一致）。A4 顺带验证 pi-ai 是否用 contextWindow 做本地强制 —— 不得引入现在没有的本地截断行为。

## §4 测试

- `loop.test.ts`（464 行）+ `loop-runlog.test.ts` **全部断言原样保留**：401 不重试、429 重试、HTML/畸形 200、非数字 usage、空回复、历史顺序、Anthropic tool_result、thinking 忽略、SSE 分块与中途断流。（承接 #16）
- 注入方式：`fetchImpl` 改为经 A3 的 per-call 注入点喂给 pi-ai（A3 是硬门：无注入即无方案 A，不存在"仅测试可用"的降级形态）。断言本身一条不改 —— 测试是行为契约，不迁就实现。
- 每条实际 route 加真实中转 contract test（请求快照 + 冒烟）。

## §5 迁移顺序

1. **阶段 0**：mini-spike（§0），结论回写。
2. **阶段 1**：`loop.ts` 内部替换 + 全部测试绿；调用方零改动、零感知。
3. **阶段 2**：真实中转冒烟（writer route 优先）+ dogfood 一轮写稿全流程。
4. 收尾：删除死代码（手写协议构造、SSE 解析），`withRetry` 保留。

无批量调用方迁移阶段 —— 这是 A 相对 B 最大的执行优势。

## §6 相关但解耦的小修（一起排期，独立提交）

~~chat 的 `read_url` 加单条结果截断~~ **实现期核实：已存在** —— chat-router.ts 的 read_url 早有 4000 字符单条截断（"进对话上下文的预算上限"），codex #10 的前提部分失真。残留问题是多次调用的**累积**预算消耗，代码注释已明确归入 v1.5 预算策略，本迁移不动。（#10 关闭）

## 落地记录（2026-07-18）

- 阶段 0（spike A1-A5）✅ / 阶段 1（引擎替换 + 1166 测试全绿×5 连跑）✅ commit `37beaaf` / 阶段 2（真实中转端到端冒烟）✅
- 行为差异台账（相对旧引擎，均已在测试中声明）：
  1. 坏 JSON 工具参数被 pi-ai partial-json **抢救**为尽力对象（旧：进 "Error:" 消息让模型自纠）—— 契约升级，loop.test.ts 有注释。
  2. 非 SSE 的 200（HTML/error-shaped JSON）由观察器归一化为 **400 + 原 body 透传**：provider 错误信息保留、fail-fast 语义保留；合法的"非流式 JSON 200 成功响应"不再被接受（旧引擎兼容此形态，判断为测试遗产而非真实 relay 行为）。
  3. anthropic 请求新增 prompt cache 字段（pi-ai 默认）：A4 实测中转接受且产生 cacheWrite —— 正向成本优化。
  4. anthropic 工具定义附带 `eager_input_streaming` 字段：A5 实测中转接受。
  5. usage 口径统一为 input+output（cache 不计入预算），openai 侧要求中转发 `prompt_tokens/completion_tokens` 拆分（include_usage 下标准行为）。

## §7 决策记录：为什么从 B 回退到 A

同日时间线：创始人先选 B（全换 AgentSession，动机=会话能力+生态对齐）→ codex consult 评审出 9 P1 + 12 P2（原文见 codex 会话 `019f7093-c192-7ac1-8a90-2c4dad60b799`，B 版 spec 见 git `96594ba`）→ 创始人回退到 A。

回退理由：codex 的修复方案把 B 的两大卖点结构性降级 —— 持久会话被修成可丢弃派生缓存（conversation-store 仍是唯一事实源），自动压缩被修成第二道防线（第一道是工具截断，现架构即可做）；而代价上涨（spike 6 点门、兼容 facade、会话生命周期状态机、正式适配层、双存储事务）。21 条发现中 14 条为 B 特有（双事实源、路径穿越、ResourceLoader 逃逸、重试重放写工具、上下文冻结、压缩语义等），A 全部规避；其余 7 条（#5 #6 #11 #14 #15 #16 #21）为"碰 pi-ai 即承接"，已全部融入本设计（见各节标注）。

B 不被堵死：pi-ai 是 pi 栈地基，A 落地后若聊天真正需要会话树/压缩，再以独立提案重启 AgentSession 评审。

**codex 二审记录**（同会话，tokens 764,490）：7 条承接项 5 PASS、2 FAIL（#6 #14 —— A3 软兜底被判伪降级）；新增 2 P1（重试须包完整流消费、fetch 注入须 per-call 且禁改 globalThis.fetch）+ 1 P2（模型元数据来源未定义）。初判 NO-GO；上述 5 点已全部修入 §0/§2/§3/§4，NO-GO 条件消除。
