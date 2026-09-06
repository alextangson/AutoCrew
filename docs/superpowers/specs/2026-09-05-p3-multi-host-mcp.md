# P3：多宿主 MCP——Claude 写文案，Codex 做封面与剪辑，AutoCrew 只当工具与案卷

> 日期：2026-09-05
> 状态：spec v2（codex 评审 19 条已逐条吸收，映射见 §10），待创始人确认 §9
> 创始人原话（2026-09-05）：「就做成 AutoCrew 的 MCP……我本身是想 Claude 写文案，Codex 做封面和剪辑，这样多 agent 协作的。」
> 关系：设计源头是 `2026-09-02-dsh-employees-and-case-files.md`（员工 = 人设 + 工具集 + 输入清单 + 提交契约；协作靠案卷不靠互聊）。P1 立意、P2 一把钥匙已落；本篇把「宿主」从 dsh 一家扩成 Claude Code / Codex / dsh 三家，并把写稿这一环从产品内部循环搬到宿主模型手里。

## 0. 一句话

AutoCrew 不再自己雇写手；它把「写一篇稿需要的一切」打成一份写作包交给宿主里的模型，收回稿子时用同一套门禁把关，再把稿子递到下一位员工的桌上。谁来写、谁来做封面、谁来剪，由用户在自己的宿主里决定；产品只保证事实同源、门禁同一、交接有据、**只有一个进程在写盘**。

## 1. 现状（全部有代码出处）

### 1.1 MCP 已经有，但只给一家用过，而且不止一个进程在写

- 服务端 `POST /mcp`（`desktop/server.ts:193`），单个 JSON-RPC 对象请求/应答；`GET /mcp` 返回 405（`:200-203`）；没有 `Mcp-Session-Id`、没有 SSE、不处理 batch。协议版本 `2025-11-25`（`mcp/server.ts:31`，该版本已不要求 batch）。
- `initialize` **完全忽略 `params`**（`mcp/server.ts:97-107`），HTTP 侧主体固定 `local-user`（`desktop/server.ts:220-222`），`McpAccessContext` 没有宿主身份字段（`mcp/access.ts:22-30`）。
- 认证：`Authorization: Bearer <server-token>` 绕过 origin 检查（`src/desktop/server-auth.ts:70-73`），一把 token 能调全部 21 个工具；token 在 `<dataDir>/server-token`，0600（`server-token.ts:15-37`）。
- **两个写进程**：Claude Code 的 `.mcp.json` 用 stdio 起独立的 `bin/autocrew.mjs mcp`（`.mcp.json:4-5`），Codex 走守护进程 HTTP；而 `transitionStatus` 的按 id 串行只在本进程内有效，代码明说「跨进程仍是 last-writer-wins」（`local-store.ts:390-395`）。
- `tools/list` 直接透出 TypeBox schema（`mcp/server.ts:112`），dsh 桥的 `toLosslessJson`（`adapters/dsh/src/tools.ts:64`）在 MCP 路径上没有对应。
- Codex 接远端 MCP 的官方方式：`codex mcp add <name> --url <url> --bearer-token-env-var <VAR>`（`url` 键即选定流式 HTTP）。**Codex 的远端客户端从没连过这个服务端**。

### 1.2 写稿仍是产品内部的循环；Claude 那边有个绕过门禁的老技能

- `autocrew_workflow write` 起 `startGenerateScript`，写手模型来自引擎 `writer` 岗位（`workflow.ts:356-363`，`generate-script.ts:718`）。创始人想要 Claude 写。
- Claude Code 侧的 `skills/write-script`（「真正动笔的那一个」）让 Claude 写完直接 `autocrew_content save`——**没有立意卡、没有证据台账、没有三道门**。
- 循环里**可无状态暴露**的：`buildScriptPrompts`（`script-prompt.ts:73`）、`assembleResearchInput`（`input-budget.ts:105`）、三道门、`assembleAndHumanize`、`finalizeScript / finalizeBlocked`。
- **闭包状态**三样：`buildSubmitTool` 的修复计数与捕获（`script-payload.ts:147-200`）、`EvidenceLedger`（只有 `createEvidenceLedger()` 与 `snapshot()`，**没有从快照恢复的入口**，`evidence-ledger.ts:59-132`）、`find_evidence` 配额（`targeted-research.ts:473`）。
- 审稿 `reviewAndConverge`（`script-review.ts:406-464`）审完**自动调写手修**，`reviewOnce / reviseOnce` 是私有函数（`:270-360`）——「只审不修」今天没有入口。

### 1.3 交接靠状态机，没有「谁在干」

- `ContentStatus` 十三态（`local-store.ts:111-147, 1121-1141`），阶段闸 `stage-guard.ts:44-63`。`Content` 上没有 owner / claim / handoff 字段（`local-store.ts:211-302`）。
- 封面 `autocrew_cover_review approve` **只标记封面评审单，不推稿件状态**（`local-store.ts:1085-1105`，`cover-review.ts:127-135`）；`create_candidates` 读旧 review 算 `revision = max+1`、异步出图、整份 `saveCoverReview`——两个调用者同时跑会互相覆盖（`cover-review.ts:306-313, 368-399`）。
- `skills/cover-generator/SKILL.md` 只允许中转 `gpt-image-2`、只做 3:4 与 4:3、禁 Gemini、禁 `generate_ratios`（`:14-19`）；工具实现允许 Gemini 与四种比例（`cover-review.ts:195-209, 547-653`，工作台用）。
- **视频线零 MCP 暴露**，且自带乐观锁、runner 租约、心跳、CAS、暂存晋级（`video/runner.ts:7-15`，`video-store.ts:195-212`）。

### 1.4 条款

- OpenAI 使用条款「你不能做的事」含「不得自动化或程序化地提取数据或输出」。用户自己运行 Codex CLI 并给它接 MCP 服务器是官方支持的用法，**本篇路线没有灰区**。
- 灰区在反方向——第三方产品后台起 `codex exec` 拿订阅额度当后端。GitHub 讨论 #8338 里 OpenAI 维护者只答「代码可 fork，条款看使用条款」。**本篇不新增这种用法**；既有的公众号配图 `kind:"codex"` 子进程通道属于此类，记为风险，不动也不扩。

## 2. 目标与不做

**目标**
- G1 **宿主写稿**：接了 AutoCrew MCP 的宿主（Claude Code / Codex / dsh）里的模型能领写作包、按需补证、提交稿子过同一套门禁，稿子落进同一个 `contents/<id>`，与内部写手稿在状态、字段、审稿上不可区分。
- G2 **员工分工靠桌面**：写手、封面师、剪辑师各有待办桌；认领带租约与令牌，谁在干、干到哪，工作台与任一宿主都看得见。
- G3 **三家宿主一键接入**，且**全部经守护进程一个写入口**。
- G4 **门禁不因换宿主变松**：三道门与审稿判据对宿主稿与内部稿同一份代码。

**不做（明确排除，可否决）**
- 不做 agent 互相发消息。
- 不做完整案卷制（`O_EXCL` 锁 + 收据 + 启动 reconciliation，设计稿 §3.5）：单进程写入 + 认领令牌 + `packId` 已覆盖两宿主协作需要的隔离；收据以 `Content` 字段代替。
- 不在产品里按宿主路由模型；内部杂活（视角调研、补证、审稿）仍走 engine.json。
- 不做剪辑师工具面（P3c 单列）；不做云端、多用户、宿主自动发现。
- 不把 `codex exec` 当文字模型后端。
- dsh preset 仍只放行写作线工具：封面师、剪辑师只在 Claude Code / Codex 宿主上跑。

## 3. 一个写入口：所有宿主经守护进程

- **`bin/autocrew.mjs mcp` 改为转发器**：把 stdio 上的 JSON-RPC 原样转发到 `http://127.0.0.1:<port>/mcp`（带本机 token），不再在自己进程里 `registerAutocrewCapabilities`。守护进程没起 → 转发器返回一条 JSON-RPC 错误「AutoCrew 服务没有运行，先 `npm start`」，不静默起第二个写进程。Claude Code 的 `.mcp.json` 不用改形状。
- 于是 `transitionStatus` / `serializeContentWrite` 的按 id 串行（`local-store.ts:398`）对全部宿主生效；这是本篇所有并发承诺的前提，**P3a 第一条验收**。
- 工作台（浏览器）与 MCP 宿主共用同一进程，今天已如此。

## 4. 宿主身份与令牌

### 4.1 命名 token（归因 + 撤销）

- `<dataDir>/tokens/<host>.token`（0600），由 `autocrew host <codex|claude-code|dsh>` 生成（§7.1）；`server-auth` 接受目录下任一 token，`principal.subject = <host>`。既有 `server-token` 仍有效，subject `local-user`（工作台自动化、老配置）。
- 每次 `tools/call` 的 `McpAccessContext` 带 `host`（`mcp/access.ts` 加字段），供 `writtenBy.host`、`claim.host`、`handoffs[].by`。**不依赖 `clientInfo`**：它在无会话的 HTTP 上没有稳定落点，只作日志补充。
- 撤销 = 删文件。「接入更多 · 宿主」卡列出每个 token 的最后调用时间与一键撤销。
- 风险如实记：token 仍是本机全能凭证（一把能调全部工具）。本篇不做按宿主的工具白名单——单用户本机，威胁模型是误操作不是恶意；`autocrew host` 文案写明「这个文件等于你的编辑部钥匙」。

### 4.2 MCP 协议补齐（P3a 第一天先 spike）

- 用 Codex 的远端客户端（`codex mcp add … --url`）与 Claude Code 的 HTTP 型 MCP 各真连一次现有 `/mcp`，记录：是否要求 `Mcp-Session-Id`、是否发 `GET`、`Accept` 头、`notifications/initialized` 处理。**spike 结论决定下面哪几项做**：
  - `Mcp-Session-Id`：`initialize` 时签发、后续请求校验（会话表内存态，重启失效即重新 initialize）——若客户端要求则做。
  - `GET /mcp`：继续 405（流式 HTTP 允许服务端不开 SSE）——若客户端拒绝再开最小 SSE（只保活，不推送）。
  - `notifications/*` → 202（已有）。
- **spike 记录（2026-09-05 深夜，隔离目录 + 记录请求头的代理）**：Codex CLI 0.145 远端客户端（`clientInfo.name = codex-mcp-client`）请求 `protocolVersion 2025-06-18`、`Accept: text/event-stream, application/json`，我们回 `2025-11-25` 它照常继续；全程只发 POST，不发 GET，不带会话 id；`initialize → notifications/initialized(202) → tools/list(24KB) → tools/call` 端到端通。标准 TypeScript SDK 客户端（Claude Code 同款）同样全通，只多发一次 `GET /mcp`，我们的 405 被容忍，`sessionId` 保持 null。**结论：不加会话 id、不加 SSE**；只把 `initialize` 改为回显客户端请求的版本（在我们支持的 `2025-03-26 / 2025-06-18 / 2025-11-25` 内）。另一个事实：`codex exec` 非交互模式会自动取消 MCP 工具调用（openai/codex #24135、#16685），只有 `--dangerously-bypass-approvals-and-sandbox` 能放行；交互会话按次审批正常。P3b 的 Codex 验收按交互会话或带该参数跑，`autocrew host codex` 文案要写这一条。
- `tools/list`、`tools/call` 结果经 `toLosslessJson`（从 dsh 桥搬到 `src/utils/` 共用）。
- 资源加两个：`autocrew://desk/<employee>`、`autocrew://contents/<id>/writing-pack`。

## 5. 写作包与提交：把写手循环翻过来

### 5.1 新工具 `autocrew_writer`（独立工具，不塞进 `autocrew_workflow`）

| action | 输入 | 输出 |
|---|---|---|
| `pack` | `topic_id, platform, direction?, skip_reason?` | `content_id, pack_id, pack_md, budget{find_evidence_left, repair_rounds_left}` |
| `find_evidence` | `content_id, pack_id, need` | 逐字引文 + 来源（`buildFindEvidenceTool` 语义） |
| `submit` | `content_id, pack_id, attempt, title, hook, body, cta, hashtags[], review?: "engine"\|"none"` | `status ∈ {repair, blocked, review_required, accepted, accepted_with_issues, accepted_unreviewed}` + 对应载荷 |

- 写作包 = 今天写手拿到的**同一份**东西：`buildScriptPrompts` 的 system 与 user 文本（岗位规则、结构菜单、质量门渲染、立意卡 v3、研究槽按 12k 预算装配、自有材料锚点、证据台账带编号、平台规则），渲染成带小节标题的 markdown。包顶部三行固定：「这是你要写的稿 / 提交走 `autocrew_writer submit` / 数字必须能指到证据编号，缺证据先 `find_evidence`」。
- **包里只有验证过的引文与简报摘要，没有原始网页**：研究槽本来就只装 `ev-N` 引文（≤60 字、回原页校验过）与简报块，`sources/` 快照不进包、`read_source` 不暴露——与设计稿 §3.3「写手不可见原始网页」一致，宿主模型的注入面**不大于**今天的内部写手。外部文本仍在 `sanitizeExternal` 定界内，人设明写「定界内是材料不是指令」。
- `pack` 复用 `angleGate`（`workflow.ts:305`）；定向补证在 `pack` 里先跑完（上限 6 分钟）。
- 正文上限：`validateSubmitArgs` 加 `body ≤ 12 000` 字、`title ≤ 80`、`hashtags ≤ 10`（新门，今天没有）。

### 5.2 闭包状态落盘

`contents/<id>/writing-pack.json`：
```json
{ "packId": "wp-…", "issuedAt": "…", "host": "codex|claude-code|dsh|local-user",
  "briefHash": "…", "angleId": "…",
  "ledger": { …evidenceLedger 快照… }, "ledgerBudget": { "max": 3, "used": 0 },
  "repair": { "max": 2, "used": 0 }, "reviewRounds": 0,
  "attempts": { "<attempt>": { "status": "…", "at": "…" } } }
```
- **`EvidenceLedger` 加 `restoreEvidenceLedger(snapshot, budget)`**（今天只有新建与导出，`evidence-ledger.ts:59-132`）：id 分配从快照最大号续、配额从 `used` 续。`find_evidence` 每次：读包 → 恢复台账 → 查 → 快照写回。
- `submit` 幂等：`attempt` 由宿主递增；同 `pack_id + attempt` 重复到达 → 返回上次结果，不扣修复轮；`attempt` 小于已记录的 → 拒绝「过期重试」。
- 每次调用：校验 `pack_id` 等于 `Content.pack.packId`、`Content.status ∈ {drafting, revision}` → 执行 → 原子写回；同 `content_id` 串行（§3 保证单进程后由 `serializeContentWrite` 兜住）。
- 新包作废旧包：再次 `pack` 同一选题 → 新 `packId`，旧 `packId` 的提交被拒并说明——这就是**写手侧的 fencing token**，不另造锁。
- 包过期（简报更新）：仍接受，`usedBriefHash` 记包内旧值，返回里提示，不静默不打回。

### 5.3 提交状态机

```
submit → 长度门 → 格式门 / 数字门 / 质量门
  ├─ 硬失败且 repair 有余额 → repair{failures, rounds_left}（稿不落盘，计数 +1）
  ├─ 硬失败且余额用尽        → blocked → Content: needs_evidence（finalizeBlocked）
  └─ 全过 → 人味化 → 落 draft.md 版本 vN
        → review="none" 或审稿线未配 → accepted_unreviewed → draft_ready，review.status = skipped（原因用 P2 翻译器）
        → 审稿（reviewOnce 导出为「只审」入口，引擎 reviewer 岗位）
            ├─ 无 blocker → accepted → draft_ready，review.status = passed
            ├─ 有 blocker 且 reviewRounds < 2 → review_required{issues, round} → Content: revision；宿主改后再 submit（attempt+1）
            └─ 有 blocker 且 reviewRounds = 2 → accepted_with_issues → draft_ready，review.status = failed
```
- `script-review.ts`：拆出 `reviewOnce` 为导出函数，`reviewAndConverge` 改为调用它 + 既有 `reviseOnce`；内部写手路径行为不变（回归测试锁定）。
- 返回体首字段永远是 `status`（六值之一），人设要求先看它。这六值是 `autocrew_writer submit` 的契约，**不是** `ReviewStatus`（仍是 passed/failed/skipped/…）。
- `Content.writtenBy = { kind: "host", host } | { kind: "engine", provider, model }`；`Content.pack = { packId, issuedAt, host, submittedAt? }`。`draft` 视图与稿卡：有 `pack` 无 `submittedAt` 且 `drafting` → 「写作包已发给 codex，未收到稿（12 分钟）」，不再误报「后台生成中」。

### 5.4 内部写手保留

`autocrew_workflow write` 不删。两条路径共用 `gatherInputs → buildScriptPrompts → 门禁 → 审稿 → finalize*`，区别只在「谁生成正文」。单测：对同一选题，内部路径与宿主路径的门禁输入（格式门/数字门/质量门参数）快照一致。

## 6. 待办桌与认领

### 6.1 `autocrew_desk` 工具

| action | 语义 |
|---|---|
| `inbox(employee)` | `writer` = 已选立意卡且无稿的选题 + `revision` 中的稿；`cover` = `cover_pending` 且无已批准封面；`editor` = `editing` 且 `videoDone` 未置。每项带 `content_id/topic_id/title/platform/status/claim` |
| `claim(content_id, employee)` | 写 `Content.claim = {employee, host, token, at, leaseUntil}`（host 来自 §4.1 主体），租约 30 分钟，返回 `claim_token`；已被**别的 host** 持有且未过期 → 拒绝并返回持有者；同 host 重复 claim → 续约返回同 token |
| `release(content_id, claim_token)` | 令牌匹配才清除 |

- **认领是软门，令牌是硬门**：内容没有有效 claim 时，任何写操作直接执行并自动写 claim（单人单机不设卡）；内容有有效 claim 时，写操作（`autocrew_writer submit/find_evidence`、`cover_review create_candidates/revise/approve/platform_ratios`、`content update/transition`）必须带匹配的 `claim_token`，否则拒绝并说明持有者。租约过期后新 host 的 claim 换新令牌，旧令牌的迟到写入被拒——这就是 fencing。
- 续约：任何带匹配令牌的写操作自动把 `leaseUntil` 推 30 分钟。
- 封面竞态补一刀：`create_candidates / revise` 保存 `CoverReview` 前校验 `revision` 仍等于读取时的值（CAS），不等则拒绝「封面评审单已被更新，重新 get」。
- `Content.handoffs[]` 追加式 `{from, to, at, by}`，在 `draft_ready`、`approved`、`cover approve`、`videoDone`、`publish_ready` 五处转换写入。
- 稿卡徽章：「Claude 写」「Codex 封面中 · 12 分钟前」「租约过期」。

### 6.2 一个选题的三段路（按代码实际状态机）

1. 总编辑 + 写手（Claude 宿主）：`research` → 念卡 → `select_angle` → `autocrew_writer pack` → 模型写 → `submit` → `draft_ready` → 创作者过稿 → `approved`。
2. 封面师（Codex 宿主）：`desk inbox cover` → `claim` → 按 `cover-generator` 技能：`create_candidates ratio=3:4` → 三候选给创作者 → `revise` → `approve` → `platform_ratios ratios=["4:3"]` → `release`。**approve 只标记封面已批准**（`local-store.ts:1085-1105`）；推进到 `publish_ready` 仍走既有 `autocrew_pre_publish`。封面出图**按技能走中转 `gpt-image-2`**；工具里的 Gemini 与其他比例是工作台用的，人设不碰。
3. 剪辑师（Codex 宿主，P3c）：`desk inbox editor` → 经 `createVideoService` / runner 的租约与 CAS，不直接碰 store。

## 7. 宿主接入

### 7.1 `autocrew host <codex|claude-code|dsh> [--dir <workspace>]`（新 CLI 子命令）

- 前置：服务已启动过一次（token 目录由服务创建）；没起 → 提示 `npm start` 后重跑。
- 生成 `<dataDir>/tokens/<host>.token`（已存在则复用），打印接入步骤，**token 只以文件路径出现**：
  - Codex：`export AUTOCREW_MCP_TOKEN=$(cat ~/.autocrew/tokens/codex.token)` + `codex mcp add autocrew --url http://127.0.0.1:4317/mcp --bearer-token-env-var AUTOCREW_MCP_TOKEN`
  - Claude Code：`.mcp.json` 已有（转发器自己读 `tokens/claude-code.token`）
  - dsh：指向 `adapters/dsh/README.md`
- `--dir`：Codex 写 `AGENTS.md`（§7.2），Claude Code 写 `CLAUDE.md` 片段；已存在则追加带定界符的段落，不覆盖。

### 7.2 人设：改写既有技能，不新建

- **Claude 总编辑 + 写手**：`skills/write-script` 改为 `autocrew_writer pack → 写 → submit`（收到 `repair` 按条修不重写；`review_required` 只改被点名的句子；数字没编号就删或 `find_evidence`；先看 `status`）。`skills/spawn-writer` 改为 `research → 念卡 → select_angle → write-script`。`skills/research` 从 `autocrew_research`（dsh 审计判定不合格）改指 `autocrew_workflow research/status`。dsh preset 人设十条不变，写稿段同步。
- **Codex 封面师**（`adapters/codex/AGENTS.cover.md`）：四段骨架；流程 = `desk inbox cover → claim → autocrew_content get → cover-generator 技能 → release`；禁止用代码画图、禁止跳过身份锁定、只做 3:4 与 4:3、模型失败先 `doctor {probe:true}`。
- **Codex 剪辑师**：P3c 再写。
- 能力一致性测试：三份人设与三个被改写技能里出现的工具名必须在该宿主可见的工具表里（Claude Code / Codex = 全部 MCP 工具；dsh = `PORTED_TOOLS`，**不含封面**）；「读文件/跑命令」类动词必须是宿主自带工具。

## 8. 边界（product-sense 五问，即验收清单）

**状态**
- 领包不提交：`Content.pack` 有、`submittedAt` 无 → 稿卡「写作包已发给 X，未收到稿」；租约到期灰显；再次 `pack` 作废旧包。
- 未认领直接写：执行并自动 claim。
- 两宿主同一稿：第二个 `claim` 被拒返回持有者；过期后可接管，旧令牌被拒，`handoffs[]` 记接管。
- 审稿线未配或坏：`accepted_unreviewed` + `review.status = skipped` + 线路描述。
- 守护进程没起：stdio 转发器报「服务没运行」；Codex 端 401/连接失败由 `autocrew host` 文案预告。
- 视频稿封面：`cover_pending` 前必须 `videoDone`（既有阶段闸），封面师 inbox 只列已过闸的。

**最坏输入**
- 正文超 12 000 字 / 标题超 80 / hashtags 超 10 或非数组 / `content_id` 不存在或 `archived`：拒绝并说明。
- 写作包里的定界文本含指令：包内只有校验过的引文与摘要（§5.1），人设明示。
- 并发 `find_evidence` 超配额：串行 + 配额，第 4 次「已用完」。
- `attempt` 乱序：小于已记录的拒绝；相同的返回上次结果。

**防呆**
- `status` 六值是返回体首字段。
- `release` 忘了：租约兜底；看板可手动释放。
- 撤销 token：删文件即生效，宿主下一次调用 401。

**失败可见**
- 审稿引擎失败、补证失败、人味化失败进 `submit` 返回体与 `Content.lastError`（P2 翻译器）。
- 租约过期、包作废、令牌被拒进 `handoffs[]` 与 events。

**明确不处理**：见 §2「不做」。

## 9. 待创始人确认

1. 审稿默认仍由产品内部引擎（`reviewer` 岗位）做，宿主只负责「修」。
2. 封面出图按技能走中转 `gpt-image-2`，不走 Codex 订阅；Gemini 与其他比例只留给工作台。
3. P3c 剪辑师单独排期。
4. 认领是软门、令牌是硬门；租约 30 分钟。
5. Claude Code 的 stdio 入口改成转发器：守护进程没起就不能用，不再有第二个写进程。

## 10. 分片与验收

| 片 | 内容 | 验收证据 |
|---|---|---|
| P3a 入口与写手 | §3 转发器；§4 命名 token + `McpAccessContext.host` + spike 结论落地 + lossless + 资源；§5 `autocrew_writer` 三动作 + 台账恢复 + `reviewOnce` 导出 + 幂等 + 长度门 + `writtenBy/pack` | Codex 与 Claude Code 远端客户端各真连一次并 `tools/list`；脚本宿主直连 `/mcp` 走 `pack → find_evidence → submit` 四次：格式门打回、数字门打回、同 attempt 重放不扣轮、通过并被审稿点名 → 再提交 → `draft_ready`；内部路径回归测试全绿；门禁输入快照两路径一致 |
| P3b 桌面与宿主 | §6 `autocrew_desk` + 令牌门 + 封面 CAS + `handoffs` + 徽章；§7 `autocrew host` + 三份人设 + 能力一致性测试；「宿主」卡 | 真机：Claude Code 用改写后的技能跑一个选题到 `draft_ready`（稿卡「Claude 写」）；Codex `codex mcp add` 后用封面师人设出三张、approve（稿卡「Codex 封面中」→ 封面已批准）；两宿主同时 claim，第二个被拒；旧令牌迟到写入被拒 |
| P3c 剪辑师 | `autocrew_video` 工具经 `createVideoService`/runner 暴露剪辑师需要的动作 + 人设 | Codex 对一条有 SRT 的稿走完清洗 → 粗剪确认 → 素材规划确认，`videoDone` 置位；双宿主不破坏 runner 租约 |

顺序 P3a → P3b → P3c。每片：opus 子代理实现，主循环集成验证，codex 停机门审（本机需 `-m gpt-5.5`）。

## 11. codex 评审处置表（2026-09-05，gpt-5.5，19 条）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | P1 | 按 id 串行只在本进程有效；Claude stdio 是独立进程 | 采纳：stdio 入口改转发器，全部宿主经守护进程一个写入口（§3） |
| 2 | P1 | 认领不是门就挡不住迟到写入，没有 fencing | 采纳：认领软门 + 令牌硬门；写手侧 `packId` 即 fencing（§5.2、§6.1） |
| 3 | P1 | Codex 远端 HTTP 兼容性没证明，「不通再补」太晚 | 采纳：P3a 第一天 spike，结论决定 session id / SSE（§4.2） |
| 4 | P1 | `clientInfo` 归因当前不可实现 | 采纳：归因改靠命名 token，`clientInfo` 只作日志（§4.1） |
| 5 | P1 | 本地 token 是全能凭证 | 部分采纳：按宿主发 token、可撤销、文案警示；不做按宿主工具白名单（单用户本机，§4.1 如实记风险） |
| 6 | P1 | 写作包把 research 文本给宿主，注入边界倒退 | 澄清 + 收紧：包里只有校验引文与摘要，`sources/` 不进包、`read_source` 不暴露，注入面不大于今天的内部写手（§5.1） |
| 7 | P1 | `EvidenceLedger` 无法从快照恢复 | 采纳：新增 `restoreEvidenceLedger`（§5.2） |
| 8 | P1 | 外翻 `submit_script` 不是小改，幂等键无支撑 | 采纳：`attempt` 幂等协议 + `attempts` 落盘（§5.2） |
| 9 | P1 | 「只审不修」入口不存在 | 采纳：拆出 `reviewOnce` 导出，内部路径回归锁定（§5.3） |
| 10 | P1 | 封面 approve 不推 `publish_ready` | 采纳：按代码改写三段路，推进仍走 `pre_publish`（§6.2） |
| 11 | P2 | 封面候选覆盖竞态 | 采纳：令牌门 + `revision` CAS（§6.1） |
| 12 | P2 | 20k 上限没有现有门 | 采纳：新长度门，数字定 12 000 / 80 / 10（§5.1） |
| 13 | P2 | dsh 可见工具不含封面 | 采纳：封面师、剪辑师只在 Claude Code / Codex 跑，dsh 仍写作线（§2、§7.2） |
| 14 | P2 | 技能、工具、spec 三方打架 | 采纳：人设按技能（中转 gpt-image-2、3:4/4:3），工具多余选项留工作台（§6.2、§9.2） |
| 15 | P2 | 三个写作 action 塞进 `workflow` 让 schema 更脆 | 采纳：独立 `autocrew_writer`（§5.1） |
| 16 | P2 | 领包不提交没有 UI 落点 | 采纳：`Content.pack` 字段 + 稿卡文案（§5.3） |
| 17 | P2 | 新返回状态不是现有 `ReviewStatus` | 采纳：六值是 `submit` 契约，`ReviewStatus` 不动，明写（§5.3） |
| 18 | P2 | `autocrew host` 未落，依赖顺序不清 | 采纳：写明前置与失败文案（§7.1） |
| 19 | P3 | P3c 不能绕过视频 runner 的租约/CAS | 采纳：经 `createVideoService`/runner（§6.2、§10） |

## 12. P3a 落地记录（2026-09-06）

| 提交 | 内容 |
|---|---|
| 3a89b0d | 入口半：stdio 转发器（守护进程没起就报错，不再起第二个写进程）、`<dataDir>/tokens/<host>.token` 命名令牌 + `.used` 标记、`_host` 注入、lossless、协议版本回显、`writing-pack` 资源、`autocrew host` 命令 |
| fa0e338 | 写手半：`autocrew_writer` pack / find_evidence / submit、`restoreEvidenceLedger`、`reviewOnce` 导出、attempt 幂等、长度门、`writtenBy` / `pack` 字段 |
| 本片收尾 | 真机逼出来的三处：`pack` 改异步（`preparing → pack_status → ready`，准备中重调返回同一包号；第一版同步跑几分钟，宿主 60 秒超时后服务端继续跑并覆盖包文件）；`submit` 过门后改异步（`reviewing → submit_status`，DeepSeek 审一遍 161–200 秒）；`find_evidence` 45 秒封顶、超时额度照扣并明说。数字门两类误伤：证据编号里的数字（`ev-T1.1`）与「一块主板」量词不再当数据点。dsh 桥注入 `_host: "dsh"`。收稿后重发同一 attempt 返回原结果而不是「不收稿」 |

**真机验收（隔离目录，标准 MCP SDK 客户端 + codex 命名令牌，客户端保持默认 60 秒超时）**：`pack` 立刻返回 → 120 秒 `ready`（10.8k 字包，补证含 Harrison Chase 三分法出处与 Claude Code 分层）→ 我按包写稿提交 → 门禁同步过 → `reviewing` → 200 秒 `accepted`，稿件 `draft_ready`、`writtenBy.host = codex`、审稿 `passed` 且给出一条真有价值的 advisory（指出 ev-T2.1 的「模型/内核/外壳」三层与本篇「框架/运行时/Harness」三层不是一套切法）。故意带镜头标注 + 无据数字的稿被打回并列出每处；同 attempt 重放原样返回不扣轮；错包号被拒并告知现行包号；`find_evidence` 超时明说「作废、额度照扣、还剩 2 次」；`autocrew_workflow draft` 与 `autocrew://contents/<id>/writing-pack` 资源都能读；服务端日志 `initialize client=… host=codex`。spike：Codex 0.145 与 SDK 客户端均不需会话 id 与 SSE（§4.2）。

**未做 / 遗留**：`codex exec` 非交互取消 MCP 调用（官方 issue），交互会话正常；`writer.test.ts`（1025 行）、`targeted-research.ts`（556 行）、`desktop/server.ts`（524 行）超 500 行；dsh preset 人设尚未改成 pack/submit 流（P3b）；「接入更多 · 宿主」卡（P3b）。

## 13. P3b 落地记录（2026-09-06）

| 提交 | 内容 |
|---|---|
| bf14f3f | 后端半：`Content.claim` / `handoffs`、`autocrew_desk` inbox/claim/release、令牌软门硬门、封面 revision CAS、五处交接记账、`autocrew://desk/<employee>` 资源、视图脱敏 |
| ac440db | 宿主半：改写 `write-script` / `spawn-writer` / `research` 三技能到 pack/submit 流；`adapters/codex/` 封面师与总编辑写手人设 + README；`autocrew host --dir --role`；dsh preset 同步（v5）；能力一致性测试；看板「X 写」「X 封面中」「租约过期」徽章；「接入更多 · 宿主」卡（列令牌、最后调用、撤销） |
| 本片收尾 | 真机逼出来的三处：封面桌只盯 `cover_pending` 对公众号稿永远是空的（状态机里非视频稿 approved → publish_ready 不经过封面台）→ 改为 approved 的非视频稿 + 成片审过的视频稿 + 退回封面台的；`autocrew_content` 认 `content_id` 别名（宿主照别的工具的习惯猜）；**交接即释放**——写手交稿后认领若还挂着，封面师看到的永远是「被 claude-code 持有」 |

**真机验收（隔离目录，标准 SDK 客户端两把命名令牌 + Codex CLI 真跑）**：
- 两宿主冲突：claude-code 领包后自动认领写手；codex `desk claim` 被拒「这篇正由 claude-code 处理（写手，还剩 28 分钟）」，codex 不带令牌 `submit` 同样被拒；视图里没有令牌。
- 写手全链：`submit` 被审稿点名（误区不是卡上那个——我写的是上一张卡的稿，审稿抓得准）→ 按点名改 → 数字门打回「半年」→ 改定性 → 审稿点「三段同义开头」→ 删重复 → `accepted`（一条 advisory）；`handoffs` 记 `writer → creator by claude-code`。
- 看板：「Claude 写」「Claude 写中 · 刚刚」→ 后来「Codex 封面中 · 10 分钟前」；「宿主」卡列出两个宿主的最后调用时间与撤销。
- **Codex 封面师真跑**（`codex exec` + `--dangerously-bypass-approvals-and-sandbox`，工作目录 `AGENTS.md` 由 `autocrew host codex --dir --role cover` 写入）：第一次看桌发现稿被写手持有 → 认领被拒 → 如实汇报不出图（人设纪律对）；释放后第二次：看桌 → 认领 → `autocrew_content get` 读稿 → `create_candidates ratio=3:4` → 三张 `gpt-image-2` 真图落 `assets/covers/cover-{a,b,c}-r1.png`（1086×1448，身份锁定的创始人本人 + 补丁单据 + 尺子，标题《你也有块不敢碰的代码》）→ 摆出三案停下，未 approve 未 release，汇报认领令牌与尺寸。
- **Claude Code 无头运行未验**：`claude -p` 在本机子进程里报「Not logged in」，写手技能的行为只能由创始人在交互式 Claude Code 里验证；技能文本、能力一致性测试、pack/submit 契约（P3a 用 SDK 客户端走通）是现有证据。

**遗留**：`writer.test.ts`（1025 行）、`local-store.ts`（1486）、`cover-review.ts`（706）、`Board.tsx`/`Editor.tsx` 超 500 行；`content:trash` 视图未脱敏（非看板面）；写手技能里 `autocrew_content` 仍写 `content_id`（已兼容）。

## 14. P3c 剪辑师：设计（2026-09-06）

### 14.1 事实（调查出处）

- 视频线状态机 `ingest → transcribe → cut → edit → assemble → render → review → done`（`state-machine.ts:18`），`edit` 与 `review` 是硬人工门，`done` 只能从 `review/awaiting_human` 到达（`:128-139`）。所有写都过 `serializeVideoWrite` + `assertTransition`（`video-store.ts:80, 154-208`），版本文件用 `fs.link` 做原子仲裁（`:233-251`），runner 有租约/心跳/settle CAS（`runner.ts:92-161, 271-300`）。
- **唯一门面** `createVideoService`（`service.ts:159`）：起构建、三道门的确认/重跑/回退、预览、审核，冲突抛 `VideoConflictError`。桌面 `video:*` 22 条 IPC 是它的薄壳（`video-handlers.ts`）。
- **`videoDone` 只在桌面层盖章**：`stampVideoReady`（`video-handlers.ts:486`）在 `review_confirm verdict=approve` 后写 `Content.videoDone/videoReadyAt`；服务层的 `confirmReview` 只推 `done/done`。MCP 直接调服务会到 `done` 却永远不盖章，阶段闸就永远不放行。
- 粗剪与素材规划都是「内部 agent 提议、人确认」：`rough-cut.ts` 只提 `drops`，keeps 由代码算；`editor.ts` 只提 overlay 计划，硬规则在代码；确认只能做减法（`editor-gate.ts:82-88`）。
- 输入是 `role:"aroll"` 的稿件资产（`ingest.ts:224-233`），ASR 走 `uv` 子进程 + 1GB 模型（`asr.ts`），一次 15 分钟口播推理十来分钟；`testkit.ts` 提供 3 秒合成 A-roll、假 ASR、假渲染，转写只是 JSON，**没有 SRT 导入口**。

### 14.2 `autocrew_video` 工具（一个工具，动作与门面一一对应，全部经 `createVideoService`）

服务实例必须与桌面共用同一个（进程内队列、启动恢复只能有一份）：把 `video-handlers.ts` 里的单例取法抽到 `src/modules/video/service-registry.ts`，桌面与工具都从它拿。

| 动作 | 语义 | 令牌门 |
|---|---|---|
| `status {content_id}` | 状态 + jobs + `next`（人话：等转写 / 粗剪待你确认 / 素材规划待你确认 / 成片待审 / 已完成 / 失败原因） | 否 |
| `start {content_id}` | `startBuild`，立即返回，轮询 `status` | 是 |
| `transcript {content_id, full?}` | `getTranscript`；默认紧凑视图：单元 id、起止毫秒、文本、AI 建议（drop 标记 + 引句）；`full` 才带逐词 | 否 |
| `cut_confirm {content_id, keeps, flags?, base_transcript_revision, base_cut_revision}` | 三处乐观锁原样透传；冲突返回 `conflict:true` + 当前 state | 是 |
| `transcript_edit {content_id, unit_id, text, base_transcript_revision, base_clean_revision, base_cut_revision}` | 改字，门不动 | 是 |
| `rough_cut_rerun` / `transcribe_rerun` / `editor_rerun` / `retry` / `reassemble` | 各自前置状态由门面校验；`transcribe_rerun` 会作废人工改动，人设必须先问创作者 | 是 |
| `cut_preview {content_id, keeps, base_*}` | 后台渲染预览，`status.preview` 给路径 | 是 |
| `editor_plan {content_id}` | 计划视图：每个 overlay 的 id、位置、来源（asset / generate 占位）、时长 | 否 |
| `editor_slot_fill {plan_revision, overlay_id, library_id}` / `editor_slot_remove` / `editor_back_to_cut` / `editor_confirm {plan_revision, kept_overlay_ids}` | 同门面；`kept_overlay_ids: []` 合法 = 纯口播 | 是 |
| `review {content_id, rendered_revision, verdict, target?, timestamp_ms?, note?}` | `confirmReview` **+ 盖章**：把 `stampVideoReady` 抽成 `src/modules/video/video-done.ts` 由桌面与工具共用 | 是 |
| `asr_status` | 只读 | 否 |

- 所有排队类动作立即返回（runner 本来就是异步的），宿主轮询 `status`；单次调用不超过 30 秒（P3a 教训）。
- 令牌门与封面同款：`claim_token` 可选，别的宿主持有未过期认领即拒绝；`desk inbox editor` 已存在（`editing && !videoDone`）。
- 视频线自己的租约/CAS 不动：宿主层的认领只管「谁在这台桌子上」，runner 的租约管「谁在跑这一步」，两层各管各的。
- 不进 dsh `PORTED_TOOLS`（§2：剪辑师只在 Claude Code / Codex）。

### 14.3 人设：`adapters/codex/AGENTS.editor.md`（`autocrew host codex --role editor`）

四段骨架。纪律：机器步骤自己跑（start、轮询、重跑）；**三道门都是创作者的决定**——把 AI 的粗剪建议按「引句 + 标记」摆出来等创作者点头再 `cut_confirm`，把素材规划里的 generate 占位逐条问「填库里的哪条 / 删」再 `editor_confirm`，成片路径交给创作者看过再 `review approve`；非交互运行到门就停。`transcribe_rerun` 前必须说明会作废已改的字。不写镜头语言、不改文案、不碰发布。冲突（`conflict:true`）= 别的地方改过，重新读状态再来，不重试同一提交。

### 14.4 边界

**状态**：稿件不是视频平台 / 未到 `editing` → `start` 被门面拒并说原因；没有 A-roll 资产 → `blocked: aroll_missing`，`status.next` 说「先把口播原片放进资产」；ASR 未就绪 → `blocked: asr_not_ready` + `asr_status`；`done` 后再 `cut_confirm` = 重开（`videoDone` 会被清，人设要先问）。
**最坏输入**：`keeps` 越界/重叠 → 门面拒；`plan_revision` 过期 → `conflict`；`transcript` 超长 → 紧凑视图默认，`full` 才展开；`verdict` 非法 → 拒。
**防呆**：同一 `cut_confirm` 重发 → 第二次因 `base_cut_revision` 过期返回 conflict，不会双写；`review approve` 重发 → 门面按 `rendered_revision` 拒。
**失败可见**：`failed/blocked` 原因进 `status.next`，runner 的 `failReason` 原样附带；盖章失败返回 `stamp_warning`（与桌面一致）。
**不做**：SRT 导入口、素材采购/生成、小Lin说节奏导演（`2026-09-03` 研究稿另议）、时间线拖拽。

### 14.5 验收

- 单测：经 testkit（3 秒合成 A-roll + 假 ASR + 假渲染 + 假 runLoop）用 `autocrew_video` 走完 `start → cut_confirm → editor_confirm → review approve`，`Content.videoDone` 置位；每个门的 conflict 路径；令牌门；`status.next` 文案；桌面与工具共用同一服务实例（注册表测试）。
- 真机：隔离目录用 testkit 把一条视频稿推到 `cut/awaiting_human`，起真服务，Codex 剪辑师人设看桌、认领、读转写、摆出粗剪建议停下（非交互）；再由脚本宿主替创作者走完确认 → 编辑阶段（真 DeepSeek）→ 组装渲染（真 ffmpeg，3 秒）→ `review approve` → `videoDone`，看板显示「Codex 剪辑中」→ 完成。
