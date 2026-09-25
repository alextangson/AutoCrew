# 用 agent-craft 审视 AutoCrew：一条视频一个会话

日期：2026-09-25 · 评审依据：`~/Projects/harnessed/skills/agent-craft`（design card / symptom→layer / operate / shape 四份参考）· 证据来源：`~/.autocrew/logs/runs/2026-09-22..25.jsonl` 真实 trace、主 checkout 运行中的代码、P3/P5/digest 三份 spec、四个子代理的代码走读。

标注：**[M]** = `/Users/jiaxintang/Projects/autocrew`（守护进程实际运行的代码，含 130 个未提交文件）；**[W]** = 本 worktree（HEAD 0423dab，与 main 相同）。

**创始人裁决（2026-09-25 同日）：**
1. 剪辑线定在 Codex：ChatCut + 剪映协作，用创始人已调好的那组 Codex skills（`aroll-rough-cut`、`personal-ip-video-loop`、`video-project-lifecycle`、`alovers-video-packaging`，工作区 `~/Projects/broll/`）。Codex 留。
2. 底线：**全程走创始人自己的 Claude 订阅和 Codex 订阅额度工作**，不靠 API key 引擎。（已核实：Codex CLI 用 ChatGPT 登录态，`auth.json` 里是 tokens 不是 API key；`~/Projects/broll/AGENTS.md` 已把封面定在 Codex 内置 `image_gen` 订阅路线。）

§3–§5 已按这两条改写；§1–§2 的证据不受影响。

---

## 0. 一句话结论

一句类比：现在的 AutoCrew 像一家把写手、剪辑师、封面师分别安置在三栋楼里的工作室，楼与楼之间只有一部电话，而且只能你打过去，没有人会打给你。

三个痛点都不是模型问题，是 harness 问题，而且共享同一个根因：**P3 把「岗位」拆到了「宿主」上**（Claude 写、Codex 剪、Telegram 推、GUI 选角、GUI 出发布包），而宿主之间**只有拉、没有推**（`mcp/server.ts` 声明 `listChanged:false`，`GET /mcp` 返回 405，spec 原话「只保活，不推送」）。你现在想要的「一条视频一个会话」，在 P3 spec 里是被明确排除的：「三家对等宿主，没有一家跑全线」。

按 agent-craft 的梯子（call → workflow → agent → agent+skills → multi-agent），AutoCrew 该站在第 4 级：**一个会话里的单 agent + 按阶段加载的 skills，AutoCrew 只当工具层和案卷层**。现在站在第 5 级（跨宿主多 agent），而且是按岗位切而不是按上下文切——这正是 agent-craft `shape.md` 里点名的反模式：「Researcher → Writer → Editor 互相聊天的 agent，通常是伪装的流水线」。

创始人裁决之后，目标形态收敛成一句话：**Claude 桌面会话是一条视频的驾驶舱，Codex 是被它调度的剪辑工位，不是第二个驾驶舱。** 这仍然是第 4 级——Codex 在这里的角色是 `shape.md` 说的「one writer, many advisors」里那个「stronger specialist on call」，通过一次异步派工调用（CCB 的 `ask codex`）接活，通过一次登记调用把成片交回，中间不聊天。两边都只烧订阅额度，守护进程里的 API key 引擎退出主路。

---

## 1. 证据：真实 trace 说了什么

### 1.1 最近四天的 Claude Code 会话（runId = 一个 stdio 转发器进程 = 一个会话）

| 会话 | 日期 | 时长 | MCP 调用 | 错误 | 特征 |
|---|---|---|---|---|---|
| mof8j9 | 09-22 | 21 min | 27 | 0 | `pack_status` 轮询 **18 次**（引擎在死线路上备料） |
| eq1j0u | 09-22 | 57 min | 67 | 7 | 7 篇稿混在一个会话；`submit`×14、`content:transition`×8、claim/release×9——宿主在和状态机搏斗 |
| q9fmg7 | 09-22 | 73 min | 27 | 4 | `workflow:status` 轮询 6 次（引擎调研挂在死线路） |
| l5f80k | 09-23 | 29 min | 38 | 4 | host-first 首跑：`read_page`×18 串行、`perspective`×4、无轮询 |
| ab98zd | 09-24 | 16 min | 20 | 1 | **一次修订**就要 pack×3、pack_status×4、submit×5、review_desk×6 |

读法：09-22 那三场是老协议（引擎调研 + 引擎审稿 + 轮询），09-23 起是 host-first（P5b–d，只在主 checkout 未提交）。host-first 把「等引擎」的问题解掉了，但**协议本身的往返次数没有降**。

### 1.2 后台引擎：主线路已死，每次白等 28 秒

`~/.autocrew/engine-health.json` 记录 `main`（code.newcli.com）自 09-24 起探测失败，但路由器**不读这个文件**：

| 角色 \| 模型 | 次数 | 失败 | 平均耗时 |
|---|---|---|---|
| scout（雷达打分）\| claude-opus-4-8 via main | 75 | **75** | 27.9 s（超时） |
| scout \| deepseek-v4-pro（回退） | 61 | 0 | 59.9 s |
| targeted / reviewer / review / angle \| opus via main | 24 | **24** | 28–58 s |
| review \| deepseek（回退） | 7 | 1 | **156 s** |

- 49 个后台 run 撞上死主线路，27 个回退成功，**22 个连回退都失败**（其中 21 次是 DeepSeek key 401）。
- 三天在死线路上累计白等 **753 秒**。雷达每 30 分钟一轮，每轮先浪费 28 秒。
- 这在 agent-craft `operate.md` 里有原话：「Fall back only when the primary is actually unavailable, and always visibly. Count it, alert on the rate」；「A backup must sit in a different failure domain」。

### 1.3 写稿线本身：零模型调用，但协议啰嗦

- 最近三天 **MCP 会话内的模型调用为 0**（P5-0 生效，好事）。
- 一篇稿一个平台的**理论最少往返**：宿主调研 + 选卡 19 次，跟着每个 `next_action` 走约 22 次；给定 direction 16 次；`research_mode=skip` 7–8 次。每次 `repair` +1，每次 `review_required` +3。其中 **4 次是纯往返、不带回任何新信息**：`prepare` 之后再领一次 `scout pack`（prepare 已经把视角包带回来了）、`select_angle` 之后再 `prepare` 一次、`pack` 本身（永远只回 `preparing`）、最后的 `submit_status`（只是把 `review_desk submit` 刚返回的结果再读一遍）。（[M] `workflow.ts:247-251`、`writer-prepare.ts:285`、`writer-review.ts:476-484`）
- 给宿主的 instructions 有 18 条规则、2,702 字符，其中 3 条和代码打架：规则 3 让再领 scout pack（冗余）、规则 10 让查 submit_status（冗余）、规则 12 说 `audience_review` 随 `submit` 返回（host 模式下其实随 `review_desk submit` 返回）。工具文案还写着「通常 1–6 分钟」（[M] `writer-pack.ts:198`），那是引擎时代的数字。
- `writer pack` 在 host 模式下**永远返回 `preparing` 并让宿主 30 秒后再问**（[M] `writer-prepare.ts:285`, `:134`），而 `pack_status` 实测 7–10 秒就 `ready`。三次 pack 就是 90 秒纯等待。
- 审稿通过后再改稿：`writer submit` 报「draft_ready 不收稿」（trace 里 **5 次**，5 篇不同稿），必须绕 `editorial inspect → feedback → pack → pack_status → submit → review_desk pack → review_desk submit` 七步。
- 同一 topic 的 `read_page` **不能并行**：守护进程一个 pid 一把租约，并发就 `task_busy`（[M] `host-research-store.ts:119`）。这就是 09-23 那 18 次 read_page 只能串行、中间还夹着 52 秒和 73 秒空档的原因。

### 1.4 三处静默失败（agent-craft 最忌讳的类型）

| 行为 | 后果 | 位置 |
|---|---|---|
| `attempt` 号重复 | **新正文被丢弃**，返回旧结果并标 `replayed:true`，不报错 | [M] `writer-submit.ts:115` |
| `requirements` 改一个字 | 任务指纹变化 → **静默新建调研任务，已提交的四视角作废**，发新 task_id | [M] `scout.ts:373-408` |
| `select_angle` 不带 `brief_revision` | 静默按当前简报选卡，用户看到的「angle-2」可能不是它 | [M] `workflow.ts:335-338` |
| 守护进程重启 | 卡在 `preparing` 的 pack **永远 preparing**，`pack_status` 的 next_action 指回 `pack_status` | [M] `writer-prepare.ts:279-285` |
| 另一宿主接手调研 | `task_owned` **永不过期**，Claude 弃掉的选题 Codex 永远做不完 | [M] `scout.ts:379-380, 468-469` |
| `read_page` 抓到 404 | 配额在网络请求**之前**扣，失败也算一页；09-23 就是 404 之后紧接着「6 页用满」 | [M] `research-broker.ts:350-364` |
| accepted 后想按自己的审稿意见改 | `editorial feedback` 要求 `user_confirmed:true`，宿主的意见记不进去；直接 `pack force` 又不会把现稿嵌进新包 | [M] `editorial.ts:142`、`writer-prepare.ts:374-378` |

### 1.5 宿主每个会话背着多少 MCP 上下文

对 :4317/mcp 实测：27 个工具的 schema 45,735 字符（≈14k tokens）+ 2,702 字符 instructions（≈1.7k tokens）。**每个 Claude 会话固定背 16k tokens**。agent-craft `tools.md` 拿 Playwright 21 个工具 13.7k tokens 当反例。09-22 那场 67 次调用里 `content:transition` 错 3 次（「Invalid transition」）就是工具太多、选错工具的典型：症状→层表里的「Wrong tool or wrong arguments → description/schema」。

### 1.6 运行的代码没有指纹

守护进程（pid 77870）从主 checkout 跑，那里有 **130 个未提交条目**（96 个已改、34 个未跟踪；`src/tools/scout.ts`、`host-review.ts`、`editorial.ts`、`mcp/writing-instructions.ts` 都是未跟踪文件）。34 个未跟踪里 23 个和 `codex/host-driven-mcp` 分支的 `b86e812` 逐字节相同，另外 11 个前端文件哪个分支都没有。main 和本 worktree 都没有这套代码。agent-craft 的 Done gate 要求「fingerprint the prompt + tools + model」——现在无法回答「今天用的到底是哪一版协议」。另外 :4450 端口还挂着一个旧 server（session-10 交接里就提过）。

---

## 2. 三个痛点：症状 → 层

### 痛点 1 「没有窗口定时推灵感」

**症状层定位：宿主接入层，不是 AutoCrew 后端。**

- 推送其实存在：每天本地 9:00 Telegram 发 3–5 条候选（`digest-scheduler.ts`，`digest-state.json` 显示 09-25 已发出 3 条），回数字起深调研。但深调研完成**没有回推**（digest spec §3 明确「下一步再看」），回复也不带 `originConversationId`，GUI 的 chat follow-up 不会触发。
- 守护进程**不能推给任何宿主**（§0 说的 405 / listChanged:false），也没有任何东西能开一个 Claude 会话或往会话里塞消息：`.claude/settings.json` 只有 `enabledPlugins`，没有 hooks；`~/.claude/scheduled-tasks/` 为空；`.claude/scheduled_tasks.json` 不存在。
- 今天从「晨报到开写」要跨 **三个窗口**：Telegram 回数字 → 浏览器 GUI 看调研、选角 → 终端起 `claude` 找选题。而且选题 3 天没出卡就进回收站（`topic-expiry.ts:16`）。

**现成通道（已核实，autocrew 一行不用改）：**
- 桌面版**定时任务**（`mcp__scheduled-tasks__create_scheduled_task`）：到点新开一个会话，出现在侧栏「Scheduled」区，**可以继续对话**，工作目录可指定（指到 autocrew 仓库就能加载 `.mcp.json`）。
- `SessionStart` hook：stdout 直接注入上下文，可以在每个新会话开头塞一句「桌上有 3 条待写、1 条待剪」。
- `set_session_title("self", …)`：app 自动生成的标题可直接改。

### 痛点 2 「写作到发布包整个环节卡」

**症状层定位：三层叠加——线路层、协议层、缺工具层。**

| 卡在哪 | 层 | 证据 |
|---|---|---|
| 后台任何模型调用先在死线路等 28 s | 线路 / 路由 | §1.2；`engine-health.json` 记录了失败却没人读 |
| pack 明明 7 秒就好，宿主被告知等 30 秒 | 协议 | [M] `writer-prepare.ts:134,285` |
| 修订一轮 5–7 次往返，accepted 后要绕七步 | 协议 / 状态机 | §1.3，trace 5 次「不收稿」 |
| read_page 只能串行 | 协议（租约粒度） | [M] `host-research-store.ts:119` |
| **视频发布包（videoKit：标题、文案、封面字）没有 MCP 工具** | 缺工具 | `prepareVideoKit` 唯一调用方是 GUI 聊天 `chat-router.ts:1231`；小红书 `pre_publish` 在无 videoKit 时要求 ≤1000 字，给的修法「先生成视频发布件」MCP 做不到 |
| 视频线的粗剪 / 剪辑师 / 发布包仍然吃守护进程引擎 | 线路 | `rough-cut.ts:267`、`editor.ts:336`、`video-kit.ts:134`——和写稿线 host-first 方向相反 |
| B-roll / BGM 角色、素材库只能在 GUI 标 | 缺工具 | `autocrew_asset add` 没有 `role` 参数（`asset.ts:9-30`） |

所以「准备发布包卡」的真相是：**这一步根本不在 MCP 里**，你必须切到 GUI。

### 痛点 3 「多个窗口之间调度」

**症状层定位：两个成熟系统之间没有任何一根线，不是技术约束。**

- 写作侧的状态在 `~/.autocrew/contents/<content_id>/`；剪辑侧的状态在 `~/Projects/broll/YYYYMMDD 视频标题/00-project/notes/workflow-state.json`（`personal-ip-video-loop` 自己的四道闸门、ChatCut timeline id、封面配对审核，做得很完整）。**两边互不引用**：broll 项目里 grep 不到任何 `content-…` id 或 `draft.md`，AutoCrew 里也没有 `project_root`。连线的是你的脑子和剪贴板。
- AutoCrew 给 Codex 的剪辑师人设 `adapters/codex/AGENTS.editor.md` 指向的是内置 `autocrew_video`（FunASR + Remotion 线，吃守护进程引擎），而你真正在用的是 `~/Projects/broll/AGENTS.md` 定的「剪映内置 Agent 优先 → ChatCut / MCP」。**AutoCrew 的内置视频线对你的真实工作流是旁路**，它的 `editor` inbox 永远等不到你。
- 派工通道其实装了但没接：`~/.local/bin/ask`（CCB）可以从 Claude 会话异步把一条消息送进 Codex 面板，`pend codex` 读回复。但本项目的 `.ccb/ccb.config` 是空的、`ccb-mounted` 找不到——Codex 从没被挂到 autocrew 这个项目上。
- 技术上 Claude Code 和 Codex 看到的 AutoCrew 工具完全一样（`persona-capabilities.test.ts:59-70`），剪辑放 Codex 是**你的产品决定**（技能栈、剪映积分、Codex 订阅生图），不是被迫。这个决定本身没问题；问题是决定之后没人给两边搭桥。
- 附带发现：18 个仓库 skill 里 **5 个已经过期**（pre-publish 用了不存在的 `read` 动作；xhs-cover-review 用了不存在的 `review_pending` 状态；content-review 调 `review_scan` 不存在；spawn-batch-writer 和 platform-rewrite 走 `autocrew_content save` 绕过写手门）。

### 痛点 0（你没提但是前提）「只烧订阅额度」

守护进程里现在还靠 API key 引擎的调用，按「在不在主路上」分两类：

| 调用点 | 角色 | 在一条视频的主路上？ | 订阅化去向 |
|---|---|---|---|
| 雷达候选打分（30 min 定时） | scout | 是（没它就没晨报） | 搬进**桌面定时任务的 Claude 会话**做（host-first 打分） |
| 视频发布包 videoKit | writer | 是 | 上 MCP，宿主模型写，产品只做字数门 |
| 转录纠错 / 粗剪 / 剪辑师 B-roll 规划 / Remotion | scout / editor | **否**（Codex 的 ChatCut 线替代） | 内置视频线退出主路，不改 |
| 封面设计师 `designer.ts` + 中转生图 | cover | 否（`AGENTS.cover.md` 已定 Codex `image_gen`） | 保留为可选 API 分支 |
| 后台审稿 / 受众点评 `review=engine` | reviewer | 否（默认 `review=host`） | 保留为可选 |
| 定向补证 `targeted` | scout | 否（host 模式走 `find_evidence` 指引） | 保留为可选 |
| 周/月复盘、画像生成 | retro / persona | 否（手动触发） | 以后再说 |

结论：**主路上只有两处还吃 API key（雷达打分、videoKit）**，两处都能搬到宿主。搬完之后 `engine.json` 可以为空，§1.2 那 753 秒白等也就不存在了。

---

## 3. 目标形态：设计卡（agent-craft spine 第 1 件）

> 按 `templates/design-card.md` 写，一页，最后变成验收清单。

### Job
- 创始人的目标：**一条视频 = 桌面版里的一个 Claude 会话**（驾驶舱），会话标题就是视频标题。选题、写稿、自审、发布包、向 Codex 派剪辑、收成片、发布准备都在这个会话里；剪辑本身在 Codex（ChatCut + 剪映）做，两边只烧订阅额度。
- 一条视频在会话里的自然节奏：晨报选题 → 写稿到 accepted → **你去录 A-roll，录完把文件路径贴回同一个会话** → 会话发交接包给 Codex → Codex 跑 `personal-ip-video-loop` 四道闸门（你在 Codex 面板里审）→ 成片 + 封面登记回 content_id → 会话里出发布包、`pre_publish`、ego-lite 准备 → 你点发布。
- 成功在 trace 里长什么样：同一个会话 runId 下依次出现 `topic → scout → writer submit → review_desk accepted → video handoff（含 project_root）→ video register（final_path + 封面）→ pre_publish 通过`，并且 `session.title == content.title`，且守护进程 run-log 里这条视频**没有任何 `kind:"llm"` 记录**（零引擎调用）。
- 梯子位置：第 4 级（单 agent + 按阶段加载的 skills + 一个按需调用的专家工位）。第 3 级不够，因为剪辑那套上下文必须隔离在 Codex 里；第 5 级（跨宿主对等多 agent）是现状，它带来的就是三个痛点。

### Inputs and trust
| 输入 | 谁控制 | 可信？ |
|---|---|---|
| 会话里的用户消息 | 创始人 | 部分 |
| 抓取的网页、转录文本、雷达候选标题 | 任何人 | 否：已有 `<<<EXTERNAL_CONTENT>>>` 定界，晨报候选同样按数据处理 |
| 创作者画像、历史稿件 | 创始人 | 是（私有） |

三要素检查：私有数据（画像、稿件）+ 不可信内容（网页）+ 外发（ego-lite 发布）三个都有 → 人工检查点保持在**发布点击**（现状如此，不变）。

### Tools（只列本会话链路会碰的）
| 工具 | 用途 | 等级 | 闸门 | 幂等键 | 错误要能指路 |
|---|---|---|---|---|---|
| `autocrew_dashboard` / `topic list` / `desk inbox` | 晨报、找活 | read | — | — | — |
| `scout read_page / cite / perspective` | 宿主调研 | read（外网） | 每视角 6 页上限（已有） | task_id | 现状 scout 错误**没有 next_action**（[M] `scout.ts:704`）→ 要补 |
| `writer pack / submit` | 备料、交稿 | write | 三道确定性门（已有） | `attempt` | `attempt` 重复必须**报错**而不是静默 replay |
| `review_desk pack / submit` | 自审 | write | 画像引文校验（已有） | review_pack_id | — |
| `autocrew_video handoff`（新） | 冻结定稿 + A-roll 路径 + 约定 `project_root`，写 `contents/<id>/handoff/editor.md` | write | 稿件必须 accepted、A-roll 文件存在 | content_id | — |
| `ask codex "<交接包>"`（CCB，已装未挂） | 把交接包送进 Codex 面板，异步 | **outbound（到自己的工位）** | 只在 handoff 成功后 | content_id | `CCB_ASYNC_SUBMITTED` / submit failed |
| `pend codex` | 读 Codex 回话 | read | — | — | — |
| `autocrew_video register`（新） | Codex 把成片、封面、SRT 路径挂回 content_id，打 `videoDone` | write | 文件存在 + ffprobe；只接受 handoff 里约定的 `project_root` 下的文件 | content_id+version | — |
| `autocrew_pre_publish video_kit`（新） | videoKit：标题、文案、封面字，宿主模型写 | write（host 模型） | 字数门（已有） | content_id+draft_hash | — |
| 雷达打分（改到定时会话里） | 宿主模型给 20 条候选池打分 | read → write（存 topic） | ≤3 条/轮（已有） | 候选池 hash | — |
| Codex 内置 `image_gen` | 封面（订阅） | **spend（订阅额度）** | Codex 侧四道闸门之一 | — | — |
| `publish ego_lite_prepare` | 发布 | **outbound / 不可逆** | **人点发布**（不变） | — | — |
| `set_session_title` | 会话标题同步 | write（桌面） | — | — | — |

### Invariants
| 必须成立 | 代码里在哪强制 | eval case |
|---|---|---|
| 一条 content 同一时刻只有一个会话在写 | claim 现在按**宿主**记（P5 §1.7），两个 Claude 会话是同一身份 → 要改成按会话（或按 content 排他锁） | `two-sessions-same-content` |
| 会话标题 == 当前稿件标题 | skill 在 `select_angle` 后和标题变更后调 `set_session_title`；守护进程做不到，只能宿主做 | `title-sync` |
| 主线路探测失败后，后台调用**不再等它** | 引擎路由读 `engine-health.json`，失败 <10 min 直接跳主线路 | `dead-main-no-wait` |
| 每次回退可见、可计数 | run-log 打 `fallback` 标签 + 计数；GUI 引擎横幅显示回退率 | `fallback-visible` |
| 一轮修订 ≤ 3 次 MCP 往返 | pack 在 host 模式同步返回；`submit{review:host}` 直接带回审稿包；`draft_ready` 可直接 `submit{revision:true}` | `revision-round-trips` |
| `attempt` 重复不静默 | `writer-submit` 改为报错 `attempt_reused` | `attempt-reuse-errors` |
| requirements 改字不丢已交视角 | 指纹变化时返回 `task_changed` 让宿主确认，而不是静默新建 | `requirements-edit-keeps-perspectives` |
| 晨报候选只展示不执行 | 定时任务 prompt 只读；候选文本进 `untrusted` 块 | `injected-candidate` |
| 主路零引擎调用（只烧订阅） | 主路各动作不读 `engine.json`；run-log 按 content_id 断言无 `kind:"llm"` | `no-engine-calls-on-main-path` |
| 交接包完整：标题、定稿路径、A-roll 路径、`project_root`、content_id 五项缺一不发 | `autocrew_video handoff` 校验后才写文件；`ask codex` 只在 handoff 成功后 | `handoff-complete` |
| 没登记成片不能 `videoDone`，登记的文件必须在约定 `project_root` 下 | `autocrew_video register` 校验路径前缀 + ffprobe | `register-path-guard` |
| Codex 的回话只是报告，不是状态 | 会话只用 `register` 结果和 `content` 状态判断进度，不信 `pend codex` 里的文字 | `narration-not-state` |
| 数字门、引文门、格式门 | 已有（`number-gate.ts`、`format-gate.ts`） | 已有测试 |
| 发布永远由人点 | 已有（ego-lite 不点发布） | 已有 |

### Budgets
- MCP 调用：首稿 ≤ 25（现状 38），每轮修订 ≤ 10（现状 20），一条视频全程 ≤ 60。
- 单次调用 ≤ 60 s（宿主硬限）；后台模型每次调用主线路 **最多 1 次尝试且只在健康时**。
- `pack_status` 轮询 ≤ 3 次，之后变 `needs_review` 带原因（agent-craft：「Give every wait an end」）。
- read_page：每视角 6 页（已有）；同一 topic 允许 ≥3 路并行（租约改成按 URL 或去掉）。
- 守护进程重启后，`preparing` 超过 2 分钟自动标 `failed:daemon_restarted`。

### State and context
- 单位是 `content_id`；claim / handoffs 里**新增会话 id**（桌面 `sessionId` 或转发器 runId）。
- 崩溃：守护进程状态在盘上（tasks、pack、claims）；宿主会话压缩后靠 `SessionStart` hook 重新注入「当前 content_id / 状态 / 下一步」。
- 记忆层级：会话窗口 → 案卷文件（`contents/<id>/`）。不加向量库。

### Failure UX
- 主线路挂：显式「主线路挂了，本次用备用 DeepSeek / 未回退」，不再静默等 28 秒。
- pack 失败：原因 + 入口（现状已基本做到）。
- token 过期：「重新执行 autocrew host claude-code」（现状已有）。
- 两个会话争同一稿：报「稿件正在会话〈标题〉里，链接」。

### Evals（agent-craft spine 第 3 件，现在完全没有）
- 场景：上表 8 个 invariants + 「晨报 → 选题 → 标题 → 写 → 审 → 登记成片 → 发布包」全链 1 个 + 视频阶段「ChatCut 产物登记后 pre_publish 放行」1 个 = 10 个。
- 每场景 ≥3 trials，真实 fake world（临时 `~/.autocrew` 数据目录）+ 真实宿主模型；用户可见的门用 pass^3。
- 现有 `vitest` 是脚本化模型回复的 harness 测试，**验证的是 harness，不是 agent 行为**（agent-craft「Tests are green」那一行）。

### Traces
- 已有 `run-log`（模型 + 工具 + 输入输出，14 天滚动）。缺三样：会话 id、回退标签和计数、宿主侧「为什么停在这一步」的决策记录。

### Deliberately not handled
- 不做 agent 互发消息（保留 P3 红线 1）。
- 不让守护进程主动推送（用桌面定时任务 + hook 替代，成本为零）。
- 不在同一会话连写两个平台（保留 PRD-v4 §4.3 红线）。
- 不把 ChatCut / 剪映那组 skills 搬到 Claude 侧（创始人裁决：剪辑留在 Codex）。
- 不用 AutoCrew 内置的 FunASR + Remotion 视频线做主路；它保留但不再是 `editor` 人设的默认入口。
- Codex 是被派工的工位，不是对等宿主：不给它写手/审稿工具，不让它主动找活（`editor` inbox 只作兜底查询）。

---

## 4. 改法：按杠杆排序

### P0 · 今天能做，零后端代码

1. **给运行中的代码一个指纹**：把主 checkout 那 130 个文件提交（或至少落到 `codex/host-driven-mcp` 之上打 tag），本 worktree 合上，让「守护进程跑的是哪版协议」有答案。顺手关掉 :4450 上的旧进程。
2. **桌面定时任务「选题晨报」**：每天 9:03 本地时间，工作目录 = autocrew 仓库，prompt 只做三件事——调 `autocrew_dashboard pending` + `topic list` 取雷达候选，按「主张 / 依据 / 缺口」展示 3 条，然后等你回复数字。你回一个数字，**同一个会话**继续：`set_session_title(self, 选题标题)` → 走写作线。Telegram 晨报保留给手机端。
3. **`SessionStart` hook**：`.claude/settings.json` 加一条，调 `curl :4317/api/...`（或 `autocrew status` CLI）把「桌上有 N 条待写 / 待剪」注入每个新会话。这是第二个入口，覆盖你自己开会话的场景。
4. **把 Codex 挂到 autocrew 项目上**：在仓库目录跑 `ccb codex`（CCB 面板，Codex 交互式运行，MCP 不会被 `codex exec` 的沙箱取消；`approval_policy=never` 已设），`ccb-ping codex` 通了就能从 Claude 会话 `ask codex` 派工。今天先手动验一次：把 09-24 那条稿的交接内容（标题、`draft.md`、A-roll、`~/Projects/broll/20260924 AI工具分享`）用 `ask codex` 发过去，看 Codex 能不能在 broll 工作区接着 `personal-ip-video-loop` 跑。

### P1 · 后端小改（每项 <1 天）

5. **引擎熔断**：`engine` 路由读 `engine-health.json`，上次探测失败在 10 分钟内直接跳过主线路；每次回退写 run-log 标签并计数，GUI 引擎横幅显示回退率。
6. **pack 在 host 模式同步返回**：`writer-prepare.ts:285` 加快路径——没有引擎调用时直接等它完成（实测 7–10 秒，远在 60 秒宿主上限内），去掉 `poll_after_seconds:30`，顺手把「通常 1–6 分钟」的文案删掉。
6b. **instructions 和 next_action 去冗余**：删掉「再领 scout pack」「查 submit_status」两条规则，`select_angle` 直接返回 `ready_to_write` + writer pack 参数（省掉第二次 prepare），`audience_review` 的位置写对。目标 2.7k 字符压到 1.5k 以内。
7. **`submit{review:"host"}` 直接带回审稿包**：省掉 `review_desk pack` 一步；`review_desk submit` 保留。
8. **`draft_ready` 可直接修订**：`writer submit` 带 `revision_of: draft_hash` 时自动 `draft_ready → revision`，不再让宿主绕七步。
9. **三处静默失败改成报错**：`attempt` 重复、requirements 指纹变化、`brief_revision` 缺失。
10. **claim 按会话记**：转发器把桌面 `sessionId`（或自身 runId）作为 `_session` 注入；claim 与 handoffs 记录它；`task_owned` 加 30 分钟过期。
11. **videoKit 上 MCP、host-first**：`autocrew_pre_publish` 新增 `video_kit` 动作，标题/文案/封面字由宿主模型写，产品只做字数门和保存。这是主路上最后两处 API key 依赖之一。
12. **交接与登记两个动作**：`autocrew_video handoff{content_id, aroll_path, project_root?}` 校验稿件 accepted、A-roll 存在，按 `YYYYMMDD 标题` 约定生成 `project_root`，写 `contents/<id>/handoff/editor.md`（标题、定稿全文、A-roll、project_root、content_id、剪辑约束）并返回可直接 `ask codex` 的文本；`autocrew_video register{content_id, project_root, final_path, cover_paths, srt_path}` 校验路径在 `project_root` 下 + ffprobe，写 `Content.video` 并打 `videoDone`。`AGENTS.editor.md` 改成：读 handoff → 跑 `personal-ip-video-loop` → 最后 `register`。
12b. **雷达打分搬进定时会话**：`autocrew_topic` 新增 `radar_pool`（返回确定性候选池 20 条，`topic-radar.ts:166-203` 已有）和 `radar_score{scores}`（沿用 `relevance.ts` 的 ≥7 入库、≤3 条/轮、7 天拒绝记忆）。晨报定时任务先打分再展示。这是主路上另一处 API key 依赖，搬完 `engine.json` 可以清空。

### P2 · 技能层

13. **一个新的 Claude Code skill（暂名 `video-session`，名字你定）**：一条视频的驾驶舱剧本——晨报 → 选题 → `set_session_title` → 写作线（复用 write-script）→ 等你贴 A-roll 路径 → `handoff` + `ask codex` → 等 `register`（期间只用 `content` 状态判断，不信 Codex 的叙述）→ `video_kit` → `pre_publish` → ego-lite 准备。Codex 侧对应改 `AGENTS.editor.md`（读 handoff、跑你的四道闸门、最后 `register`），并装进 `~/Projects/broll/AGENTS.md` 的 Skill 路由。
14. **清理 5 个过期 skill**（pre-publish、xhs-cover-review、content-review、spawn-batch-writer、platform-rewrite），并把 `persona-capabilities.test.ts` 的覆盖从 4 个扩到全部。
15. **MCP 表面瘦身**：27 个工具里，`generate / rewrite / revise / humanize / style / memory / flywheel / pro_status / init` 这类 GUI 或一次性工具从 MCP 注册表摘掉或合并，目标把每会话固定开销从 16k tokens 压到 8k 以下。

### P3 · 评估（agent-craft 的 Done gate）

16. 按 §3 的 10 个场景建 eval，临时数据目录 + 真宿主模型，每场景 3 trials，报告 pass rate、pass^3 和指纹（协议版本 + 工具 schema hash + 模型）。没有这一步，上面所有改动只能说「harness verified, model behavior not evaluated」。

---

## 5. 已拍板 + 还剩的问题

**已拍板（2026-09-25）：**
1. 剪辑主路 = Codex 的 ChatCut + 剪映线，用你调好的那组 skills；AutoCrew 内置视频线退出主路。
2. Codex 留，作为被派工的剪辑工位。
3. 全程订阅额度，API key 引擎退出主路（§2「痛点 0」列了搬迁清单）。

**还剩两个小问题，不阻塞 P0：**
1. **派工用 CCB 还是手动？** CCB（`ask codex`）能让你不离开 Claude 窗口；代价是 Codex 得以面板方式挂在 autocrew 项目上，而你的剪辑习惯是在 `~/Projects/broll` 里开 Codex。折中：`handoff` 动作把交接包同时写进 `contents/<id>/handoff/editor.md` 和 `~/Projects/broll/<项目>/01-script/`，CCB 通了就自动 `ask`，没通就你在 broll 里对 Codex 说一句「接 <content_id>」。两条路都吃同一个 handoff 文件。
2. **录 A-roll 这一步放在会话里等，还是另起？** 建议就在同一会话等——稿 accepted 之后会话停在「等 A-roll 路径」，你录完贴路径就继续；这样标题、稿、成片天然在一条线上。

## 6. 完成定义（照抄 agent-craft Done gate）

- §3 每条 invariant 都指向一处代码和一个 eval case。
- eval 在实际部署的协议 + 模型上新鲜跑过，报告和指纹贴在 PR 里；用户可见的门用 pass^3。
- 读过一批真实 trace（不只看分数）。
- 未处理的项列出来。

---

## 7. 本次评审没覆盖

- GUI 工作台和 dsh 宿主的体验（本次只看 Claude Code / Codex 路径）。
- 三平台数据回流、封面线的质量（只看了它们和会话链路的接口）。
- `inbox.json` 里的 Telegram bot token 与 justoneapi key 明文（权限 0600，风险低，顺带提一句）。
- CCB 桥本身的可靠性（超时、Codex 面板掉线时 `ask` 的行为）没测，P0 第 4 条先手动验一次再决定依赖它。
- 所有「改法」都是建议，没有动代码；按你的约定，下一步是把 §3–§4 整理成 spec 送 codex consult，再定稿。
