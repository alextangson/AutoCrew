# AutoCrew

**面向中文内容团队的本地优先 AI 编辑部。**

<p align="center">
  <a href="https://s-tello.com/autocrew/"><img src="docs/assets/autocrew-film-cover.jpg" alt="AutoCrew 宣传片：你的 Agent 新媒体团队，让创作回归创作本身" width="860"></a>
</p>
<p align="center"><a href="https://s-tello.com/autocrew/">▶ 看 60 秒宣传片</a> · 让创作，回归创作本身</p>

AutoCrew 把选题、写稿、修改、封面、正文配图、发布前检查和数据回流放进同一个本地工作台。运营资料可保存到你指定的本地或 NAS 资料库，密钥与连接配置留在本机；未设置资料库时兼容原来的 `~/.autocrew/`。MCP 默认由当前宿主完成调研、立意、写作和审稿；只有明确选择后台执行时才调用另外配置的模型服务。取材或图像、视频生成仍会访问相应服务。

## 你能用它完成什么

- 用中文收集选题：候选自动翻译、评分，并给出可写角度；不满意可继续收集。
- 根据品牌、受众和历史修改习惯写多平台稿件。
- 在编辑器中逐段改写、保存版本、比较差异，并把“为什么这样改”沉淀为写作规则。
- 为一篇稿件生成 3 个真正不同的封面创意；可选用、单张重做、适配平台比例。
- 把正文中的 `[IMAGE: …]` 变成可预览、可单张重做的正文配图；发布时复用已确认图片。
- 推送公众号草稿箱前完成敏感词、内容状态、封面与正文配图检查；其他平台可生成发布文案与发布件。
- 回填或导入真实数据，生成周/月复盘；缺少数据时会明确提示补齐，而不是编造结论。

## 5 分钟启动

### 新电脑或首次安装

```bash
git clone https://github.com/alextangson/AutoCrew.git
cd AutoCrew
npm ci
npm run start
```

首次启动会构建前端、在后台启动本地服务，并打开浏览器。默认地址是 `http://127.0.0.1:4317`。

之后常用命令：

```bash
npm run restart  # 更新代码或配置后重启
npm run stop     # 停止服务
npm run start    # 启动服务
```

想在任意目录使用 `autocrew` 命令，可额外执行一次：

```bash
npm link
autocrew doctor
```

两台电脑同步代码时，在另一台电脑的仓库中执行：

```bash
git pull origin main
npm ci
npm run restart
```

### 更新

有新版本时，看板最上方会出现「有新版本 X · 看看更新了什么 · 更新」。点「更新」即一键更新：AutoCrew 会切到这个发布版、重新安装依赖、构建并重启，大约 1 分钟；任一步失败会自动退回原来的版本，并告诉你原因和日志位置。也可以在终端运行 `autocrew update`（`npm link` 之后）或 `node bin/autocrew.mjs update`。

一键更新只在这些条件下动手：用 `git clone` 安装、在 `main` 分支、程序文件没有本地改动、没有正在跑的写稿/剪辑/发布任务、服务是 `npm run start` 起的；不满足时会说明原因，请按上面的 `git pull` 步骤手动更新。每个版本改了什么见 [CHANGELOG.md](CHANGELOG.md)。

想收到新版本邮件：在 GitHub 仓库页点 Watch → Custom → Releases。

> Git 只同步程序。通过「设置 → 模型 → 用户资料库」迁移历史稿件或打开已有资料库；同一资料库同时由一台电脑运行 AutoCrew 服务。本机的模型、发布连接与访问令牌分别配置，不随资料库同步，也不要提交到仓库。

## 用户资料库

在「设置 → 模型 → 用户资料库」选择本地文件夹或已挂载的 NAS 路径。程序、用户运营资料和本机连接配置分开保存；迁移先复制和校验，重启后才切换，原资料保留。

未设置资料库的老用户继续使用原数据位置。新资料库中的定位、选题、稿件、素材、制作工程、发布记录和复盘归属独立运营主体；密钥和服务访问令牌留在本机。NAS 断连会明确报错，同一资料库只允许一个守护服务写入。

目录、迁移命令和恢复边界见 [用户资料库说明](docs/storage-layout.md)。

## 配置模型

**通过 Claude Desktop、Claude Code 或 Codex 的 MCP 写作不需要配置后台模型。** 默认使用当前宿主的模型能力与额度，AutoCrew 保存任务、资料与稿件，并执行引文和格式检查。下面的配置仅供 AutoCrew 工作台、显式 `execution=engine` / `review=engine` 或已授权的无人值守后台任务使用。第三方搜索及图像、视频服务仍有各自的额度和计费，不包含在宿主模型订阅中。

### 工作台里的对话用你自己的钥匙

工作台右栏的总编辑只跑在内置引擎上，用你自己的模型钥匙（DeepSeek 最省事）；没配钥匙时右栏只显示一句「在 设置 → 模型 里填」。
想用 Claude Code、Codex 或 WorkBuddy，就把它们接上 AutoCrew（见下文「接宿主」），在它们自己的窗口里说「帮我写一条……」。
2026-10-02 前用「本机 Claude / 本机 Codex」聊过的对话照常能打开和阅读，接着聊会走内置引擎。

### 内置引擎：端点表

配置只有**一张端点表**：填过的每个端点（地址 + Key + 模型清单）在里面存一份，主端点、备用端点、四个岗位、对话里的模型切换器全部指向它——同一把 Key 不用填四遍。

要用内置引擎，打开工作台的「设置 → 模型 → 模型 · 端点与岗位」，最少填一个端点：主端点必填，其余全可缺省。只靠接上的 Claude Code / Codex / WorkBuddy 写稿可以一个都不填（但工作台右栏的对话要用它）；深调研、选题雷达、复盘、人设、每日摘要要用你自己的钥匙（DeepSeek 最省事）。

| 位置 | 作用 | 缺省 |
|---|---|---|
| 主端点 | 内置引擎的总编辑对话、所有没单独分配的岗位 | 用内置引擎时必填 |
| 备用端点 | 主端点 429/断流时顶完这一次调用 | 不配 = 主端点失败即报错 |
| 岗位分配 | 写稿 / 审稿 / 选题 / 复盘各指一个端点 + 一个模型 | 不配 = 跟随主端点强模型 |

也可以手工写入 `~/.autocrew/engine.json`。请把 `YOUR_*_KEY` 换成自己的 Key，文件权限会在设置页保存时收紧到 0600：

```json
{
  "version": 2,
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek 官方",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "YOUR_DEEPSEEK_KEY",
      "protocol": "openai",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"]
    },
    {
      "id": "newcli",
      "name": "newcli 中转",
      "baseUrl": "https://code.newcli.com/claude/ultra",
      "apiKey": "YOUR_RELAY_KEY",
      "protocol": "anthropic",
      "models": ["claude-opus-4-8", "claude-sonnet-5"]
    },
    {
      "id": "ollama",
      "name": "本地 Ollama",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "models": ["qwen3:32b"]
    }
  ],
  "main": { "provider": "deepseek", "strong": "deepseek-v4-pro", "fast": "deepseek-v4-flash" },
  "fallback": { "provider": "newcli", "strong": "claude-opus-4-8", "fast": "claude-sonnet-5" },
  "assignments": {
    "writer": { "provider": "newcli", "model": "claude-opus-4-8" },
    "reviewer": { "provider": "newcli", "model": "claude-opus-4-8" }
  }
}
```

上面这份是**推荐形状**：写稿与审稿走中转的 Opus，主端点与备用端点分属两家——主线整站不通时备用还活着。

- `providers` 的 `id` 只允许小写字母、数字、连字符（1–32 位），创建时生成一次并落盘，**改名不会重算**；`baseUrl` 只接受 http/https，不能带账密、查询串或锚点（`localhost` 允许）；`models` 至少一个；`apiKey` 必填；`protocol` 不填按 key 前缀与域名自动推断。
- `main` 必填，指向的端点必须在表里且有 Key，否则整份配置视为**未配置**（产品会把你带回首次开机卡）。
- `assignments` 四个岗位是 `writer`（写稿、改稿、平台适配）、`reviewer`（AI 审稿）、`scout`（雷达筛选、灵感提炼、深调研）、`analytics`（复盘报告、活动重排），全部可缺省。
- 引用不存在的端点 id：该项丢弃并在设置页留一条提醒，其余照常工作。设置页保存则是整份校验，任何一条不成立就整次拒绝并告诉你是哪条——一个字节都不落盘。
- 删除被主端点、备用端点或任一岗位引用的端点会被拒绝。

**老配置自动迁移**：v1 的 `engine.json`（顶层 `apiKey/baseUrl` + `routes` + `fallback` + `providers` 四处各填一遍）读取时在内存里迁移成上面的形状，行为不变；第一次在设置页保存时才写成 v2，并在同目录留一份 `engine.json.v1.bak`。v1 里的 `codex` 专线没有任何功能在用，迁移时丢弃并提醒一句（生图链里的本地 Codex CLI 通道是另一回事，不受影响）。

### 备用端点（可选）

主端点连续 429 / 断流时，`fallback` 指向的端点顶完这一次调用，而不是把错误直接甩给你。

- `fallback` 指一个端点 + 强/快两档模型；不配 = 主端点失败即报错（今天的行为）。
- 档位对应：请求快档模型时用备用快档，其余（含岗位专属模型）一律用备用强档——宁强勿弱。
- **切换不会静默**：聊天进度条会出现「主模型接不上，备用顶上了」，工作日志里主端点的失败与备用端点的成功各留一条记录。
- 只在瞬时故障（429/5xx/断流）时触发；401/403 这类换端点也没用的错误、以及你点了「停止」的场景，都不会切。
- **同家提醒**：备用端点的主机名和主端点或任一岗位相同时，设置页会说一句「备用端点和写稿专线是同一家（xxx），它挂了备用一起挂」。只比主机名、故意忽略路径——同一家中转的 `/claude/ultra` 与 `/codex/v1` 是不同服务，但整站不通时一起死，那正是这条提醒要抓的情形。配了也能存，提醒常驻。

### 对话里的模型切换器

端点表里的每个「端点 × 模型」都会出现在总编辑对话右下角的切换器里，随时切。

- 点名了某个端点，这一轮**不带备用链**：打不通就如实报错，不会悄悄绕回主端点。
- 手改文件时：某条端点配错了只丢那一条（启动 warn 一行），**同一个 id 出现多次则该 id 全部失效**（首赢末赢都是静默换端点，最贵的那种错）。
- 「打开配置文件」按钮会用系统默认应用打开当前实际生效的 `engine.json`。

正文配图与公众号草稿箱还需要在「设置 → 接入更多」的「生图 · 封面」「公众号发布」两张卡里配置图像服务，以及公众号 AppID/AppSecret（如果要实际推草稿箱）。密钥不会回显到页面。


## 推荐工作流

### 1. 找选题

在「今日」或「内容」中点击「再找 5 条」。每条候选显示 100 分制综合评分、中文摘要和可写角度；不满意可继续收集或重评已有选题。

### 2. 写稿与修改

选中选题后开写。在编辑器中直接修改，或选中一段后让 AI 只改选区。每次保存都会成为新版本，可查看差异或回滚。

### 3. 给成稿一个结果反馈

编辑器中的「这篇稿子好不好用？」只有三个含义：

- **直接能用**：无需改动即可使用。
- **小改后能用**：方向正确，但你做了少量人工调整。
- **基本要重写**：当前稿件没有达到可用标准，可补充原因。

这个反馈只用于学习你的写作标准，不会自动修改稿件，也不会触发发布。

### 4. 先做视觉，再发布

编辑器的顺序是：

1. 封面设计：生成 3 张候选，选用或按意见单张重做。
2. 正文配图：在正文插入 `[IMAGE: 具体画面描述]`；每个位置都会出现独立卡片，可生成、预览、修改提示词后单张重做或移除。
3. 发布与分发：生成发布文案，或推送公众号草稿箱。

封面和正文配图都是后台任务。完成时工作台会自动刷新；部分成功会保留已经成功的图片并显示失败原因。

### 5. 发布与复盘

目前“推公众号草稿箱”是已接通的发布链：AutoCrew 会复用你确认的正文配图、使用选定封面，并将稿件推入草稿箱；最终群发仍由你在公众号后台确认。其他平台先以平台发布文案、视频发布件和人工发布确认为主。

发布后在稿件中回填阅读、点赞、评论等真实数据，或到「数据回流」导入 CSV；周/月复盘会据此给出下一轮选题、封面和内容建议。

## CLI

`npm link` 后，以下命令可在任意目录运行：

```bash
autocrew                       # 启动并打开工作台
autocrew status                # 查看服务状态
autocrew restart               # 重启服务
autocrew logs                  # 跟踪服务日志
autocrew doctor                # 检查依赖、前端、模型配置

autocrew topics                # 列出选题
autocrew contents              # 列出稿件
autocrew write --topic "AI 本地部署" --platform wechat_mp
autocrew revise --content content-xxx --instruction "开头更直接"
autocrew prepare --content content-xxx
autocrew retro --mode weekly   # weekly 或 monthly
autocrew runs --json           # 最近任务事件

# 面向自动化的内部能力调用
autocrew call topics:list --payload '{}'

# Claude Code 用的 stdio 转发器（把 JSON-RPC 转发给守护进程，不另起服务）
autocrew mcp

# 一键接上宿主（与工作台按钮同一套实现）
autocrew connect claude        # 或 codex / workbuddy
autocrew connect --list        # 谁接上了、上次使用时间
autocrew disconnect codex      # 删配置条目 + 撤销令牌

# 打印某个宿主的接入说明（dsh 等）；--dir 把人设写进工作目录
autocrew host dsh
```

## MCP 与 OpenClaw

AutoCrew 的网页、CLI、OpenClaw 和 MCP 使用同一套能力注册表。

### 账号洞察（insights）

在 Claude 等具备账号运营权限的宿主中说：“用 AutoCrew 生成近30天账号洞察，并给新媒体团队下一步安排。”也可以选择 MCP 的 `insights` prompt（具体斜杠命令名称由宿主显示，不覆盖 Claude 自带的 `/insights`）。

`autocrew_insights prepare` 读取并冻结现有定位、内容样本、生产进度、分平台数据和开放假设；当前宿主分析后调用 `submit`，得到完整报告与本地文件。报告包含证据、数据缺口、最多3项关键判断，以及负责岗位、优先级、具体动作、交付物、验证指标与前提。`list/get` 可回看或恢复。普通洞察不调用后台模型、不自动抓新数据，也不自动派工、改稿或发布；执行建议仍走原工作流。

默认观察30天，可传 `days`（1—366）、`platform`、`focus`。累计值与期间增量分开，缺失字段不补0，待复核数据不进入基线，只有正好第7天的日快照才计入D+7。更新后需在安全重启服务、宿主刷新MCP工具列表后使用。详见 [账号洞察设计与验收](docs/account-insights-design.md)。

### 宿主写稿

新稿从 `autocrew_workflow prepare` 开始，先复用或建立选题，保留完整 `requirements`。按返回动作领取 `autocrew_scout` 任务，由当前宿主完成取材、四个研究视角、综合和不同立意；产品保存阶段结果并核验抓取页中的逐字引文。用户看到材料、缺口和候选理由后选角，已有明确 `direction` 则直接沿用。

宿主可用自己的搜索工具找网址，再调 `scout read_page` 抓取，不需要第三方搜索 key；`scout search` 使用独立搜索服务。无法抓取的材料明确记作离线未核验声明，不伪装成已验证来源。研究阶段交给宿主执行，不能轮询等待不存在的后台研究模型。

研究与方向就绪后领取 `autocrew_writer pack`，它默认只整理已有资料，不读后台模型配置或自动补证。当前宿主写作并 `submit`，默认 `review=host`；收到 `awaiting_host_review` 后用 `autocrew_review_desk pack/submit` 领取和提交宿主审稿结果，最后用 `submit_status` 核对状态。单宿主自审标记 `host_self_review` / `host_self_reviewed`；另一宿主审阅也不会自动证明独立性。保存、自审、作者认可和发布必须分别说明。

MCP 初始化自带流程说明，亦可读取 `autocrew://writing-guide` 或使用 `write_content` prompt，无需依赖宿主发现仓库技能。已有材料须明确 `research_mode=provided` 并提供 `research`；用户明确不需研究才用 `skip` 和 `research_reason`。批量与平台适配也逐篇走完整链路。

只有明确选择 `execution=engine` 的后台调研/代写、`review=engine` 的后台审稿或已授权的无人值守任务才用额外模型 API。普通 MCP 不要求配置 `engine.json`。`review=none` 必须披露未审；`content save` 仅用于 `source=manual_import` 加 `import_reason` 的已有稿件导入，不能绕过生成稿检查。第三方搜索、图像与视频使用各自服务额度。

`audience_review` 按实际审阅结果解释读者可能停留或流失的位置；未点评或画像不足时说明限制。宿主模拟受众不是实际读者测试，不会让另一个后台模型自动重写正文。完整边界见 [宿主驱动的 MCP 写作](docs/2026-09-22-host-driven-mcp.md)。

`autocrew_editorial profile` 读取档案，`update_profile` 保存用户已确认的定位、受众、表达与样本。用户反馈先 `inspect` 取得当前 `draft_hash`，再通过 `feedback` 保存原话与稳定 `event_id`：默认只影响本篇，用户明确的长期要求才进入平台或跨平台声音规则。用户的采纳评价和模型审稿分别记录。应用反馈修改已有稿时，writer pack 带原 content_id 和 force:true，保留同一稿件。纯 MCP 不需要编辑本地档案文件或用初始化调用校准。

写作相关技能按职责使用：

| 环节 | 技能 |
| --- | --- |
| 定位与声音 | `calibrate`、`style-calibration` |
| 找题与备料 | `topic-ideas`、`spawn-planner`、`research` |
| 编排与写稿 | `spawn-writer`、`write-script`、`spawn-batch-writer` |
| 改写与把关 | `platform-rewrite`、`humanizer-zh`、`content-review` |
| 用户反馈 | `memory-distill` |
| 后续流程 | `pre-publish`、`manage-pipeline` |

这些技能是操作指引，不意味着同名独立 agent 已经运行。实际分工由工具的任务、材料包、审稿结果和交接记录证明。

### 接宿主（Claude Code / Codex / WorkBuddy / dsh）

**只有一个进程写盘。** `http://127.0.0.1:4317/mcp` 是唯一的 MCP 传输；宿主里登记的 `autocrew mcp` 只是一个 stdio 转发器，
把 JSON-RPC 原样转发到这个端点。守护进程没起，转发器就报「AutoCrew 服务没有运行，先在仓库里执行 npm start」——
不会有第二个进程在背后改同一批稿子。

#### 一键接入

首次打开工作台的引导会列出这台电脑上找到的 Claude Code、Codex、WorkBuddy，选好后点「一键接上」；之后在
「设置 → 接入更多 → 宿主」里每个宿主一行，可以接上、断开、看上次使用时间。命令行是同一套实现：

```bash
npm start                      # 先起服务
autocrew connect claude        # 或 codex / workbuddy
autocrew connect --list
autocrew disconnect claude
```

接入做三件事：发这个宿主自己的令牌（`~/.autocrew/tokens/<host>.token`，0600，不写进宿主配置）；把 `autocrew`
登记进宿主的**用户级**配置；再核对真的连上了（宿主自己的列表命令说连上，且 AutoCrew 收到了它的调用）才打勾。
改任何配置文件前先整份备份到 `<文件>.autocrew-bak`；原来已有用户级 `autocrew` 条目会直接替换，结果里写明备份位置。
仓库里的 `.mcp.json`（开发用、项目级）不动。

| 宿主 | 一键接入实际做的事 |
| --- | --- |
| Claude Code | `claude mcp add --scope user autocrew -e AUTOCREW_HOST=claude-code -- <node> <仓库>/bin/autocrew.mjs mcp`。命令行和 **Claude 桌面版的 Code 页**都读这份用户级配置，新开一个会话就能用。PATH 上没有 `claude` 时用桌面版自带的那个；都找不到才直接改 `~/.claude.json`（先备份），此时要新开会话，Claude 开着时可能把改动盖掉 |
| Codex | `codex mcp add autocrew --env AUTOCREW_HOST=codex -- <node> <仓库>/bin/autocrew.mjs mcp`，不再需要 export 环境变量。Codex 和 Claude Code 能力一样：写稿、审稿、剪辑、发布准备都能做；审片、认稿、选封面、「我发了」只有你在工作台点 |
| WorkBuddy | 把一条 `autocrew` 合并进 `~/.workbuddy/mcp.json`（别的条目原样保留，文件读不懂就不写）。重启 WorkBuddy 后生效。之后在稿件页或对话栏点「复制给 WorkBuddy」，把那句话粘进 WorkBuddy 就能接着处理这篇稿 |
| dsh | 走进程内工具桥，见 `adapters/dsh/README.md`；`autocrew host dsh` 打印步骤 |

断开 = 从宿主配置里删掉 `autocrew`（同样先备份）+ 撤销令牌。登记时带了 `AUTOCREW_HOST` 的转发器只认这个宿主的令牌，
撤销后就连不上，不会回落到老的 `server-token`。服务端按令牌认出是哪个宿主，稿子上记的「谁写的」就来自它。

Codex 提醒：`codex exec`（非交互）会自动取消 MCP 工具调用，除非加
`--dangerously-bypass-approvals-and-sandbox`（openai/codex #24135、#16685）。日常用交互式会话。

老的 `~/.autocrew/server-token` 继续有效（工作台自动化与旧配置），主体记作 `local-user`。

MCP 提供工具、`autocrew://profile` / `autocrew://topics` / `autocrew://contents` /
`autocrew://contents/<id>/writing-pack` 资源，以及写公众号、修改稿件、审稿、周复盘等提示词。

### OpenClaw 本地开发

```bash
openclaw plugins install --link .
```

## 本地数据结构

```text
~/.autocrew/
├── engine.json              # 模型与任务路由（含 API Key，勿提交）
├── publish.json             # 图像/公众号配置（含密钥，勿提交）
├── server-token             # 本机 HTTP/CLI 访问凭证（勿提交）
├── creator-profile.json     # 行业、受众、写作规则
├── topics/                  # 选题库
├── contents/
│   └── content-xxx/
│       ├── meta.json        # 稿件状态与元数据
│       ├── draft.md         # 当前稿件
│       ├── versions/        # 版本快照
│       ├── cover-review.json
│       ├── article-images.json
│       └── assets/          # 封面、正文配图与其他素材
├── learnings/               # 修改记录与学习到的规则
└── server.log               # 本地服务日志
```

## 开发与校验

```bash
npm run fe:build  # 前端类型检查与构建
npm run typecheck
npm test
npm run smoke     # 本地浏览器端到端冒烟
npm run check     # typecheck + lint + test
```

## License

MIT © [alextangson](https://github.com/alextangson)
