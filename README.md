# AutoCrew

**面向中文内容团队的本地优先 AI 编辑部。**

AutoCrew 把选题、写稿、修改、封面、正文配图、发布前检查和数据回流放进同一个本地工作台。内容与密钥默认保存在你的电脑 `~/.autocrew/`，模型调用只会发送完成任务所需的提示词和稿件内容到你配置的模型服务。

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

> `~/.autocrew/` 是每台电脑各自的本地工作数据和密钥目录，不会随 Git 同步。需要迁移历史稿件时，请自行安全复制该目录，且不要把 `engine.json`、`publish.json` 或 `server-token` 提交到仓库。

## 配置模型

打开工作台的「设置 → 模型与路由」，填入同一把 API Key 后即可按任务分流：

| 工作 | 推荐端点 | 推荐模型 |
|---|---|---|
| 写稿 | `https://code.newcli.com/claude/ultra` | `claude-opus-4-8` |
| 数据复盘 | `https://code.newcli.com/claude/ultra` | `claude-opus-4-8` |
| 选题侦察、快速任务 | `https://code.newcli.com/claude/ultra` | `claude-sonnet-5` |
| Codex 任务 | `https://code.newcli.com/codex/v1` | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` |

也可以手工写入 `~/.autocrew/engine.json`。以下是等价示例；请将 `YOUR_API_KEY` 替换为自己的 Key，文件权限会在设置页保存时收紧：

```json
{
  "apiKey": "YOUR_API_KEY",
  "baseUrl": "https://code.newcli.com/claude/ultra",
  "strongModel": "claude-sonnet-5",
  "fastModel": "claude-sonnet-5",
  "protocol": "anthropic",
  "routes": {
    "writer": {
      "baseUrl": "https://code.newcli.com/claude/ultra",
      "model": "claude-opus-4-8",
      "protocol": "anthropic"
    },
    "analytics": {
      "baseUrl": "https://code.newcli.com/claude/ultra",
      "model": "claude-opus-4-8",
      "protocol": "anthropic"
    },
    "scout": {
      "baseUrl": "https://code.newcli.com/claude/ultra",
      "model": "claude-sonnet-5",
      "protocol": "anthropic"
    },
    "codex": {
      "baseUrl": "https://code.newcli.com/codex/v1",
      "model": "gpt-5.6-sol",
      "protocol": "openai",
      "models": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
    }
  },
  "fallback": {
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "YOUR_DEEPSEEK_KEY",
    "strongModel": "deepseek-v4-pro",
    "fastModel": "deepseek-v4-flash",
    "protocol": "openai"
  },
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "YOUR_DEEPSEEK_KEY",
      "protocol": "openai",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"]
    },
    {
      "id": "ollama",
      "name": "本地 Ollama",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "models": ["qwen3:32b"]
    }
  ]
}
```

### 备用模型（可选）

主端点连续 429 / 断流时，`fallback` 块让 DeepSeek 官方 API 顶完这一次调用，而不是把错误直接甩给你。

- `baseUrl` 与 `apiKey` 必填，缺一整块忽略（启动时 warn 一行）；`strongModel` / `fastModel` 不填默认 `deepseek-v4-pro` / `deepseek-v4-flash`；`protocol` 不填按 key 前缀与域名自动推断。
- 档位对应：请求快档模型时用备用快档，其余（含写稿路由的专属模型）一律用备用强档——宁强勿弱。
- **切换不会静默**：聊天进度条会出现「主模型接不上，备用 DeepSeek 顶上了」，工作日志里主端点的失败与备用端点的成功各留一条记录。
- 只在瞬时故障（429/5xx/断流）时触发；401/403 这类换端点也没用的错误、以及你点了「停止」的场景，都不会切。

### 自定义端点（可选）

`providers` 是你自己增删的端点清单：配好后，总编辑对话右下角的模型切换器里会按端点分组列出「端点 × 模型」，随时切。它是**额外**通道——主端点、任务路由、备用端点全都不受影响。

- 在「设置 → 引擎 · 模型服务」里增删即可，不用手改文件；「打开配置文件」按钮会用系统默认应用打开当前实际生效的 `engine.json`。
- `id` 只允许小写字母、数字、连字符（1–32 位），由创建时生成一次并落盘——**改名不会重算**，你在切换器里选中的端点不会因为改个显示名就失效。
- `baseUrl` 只接受 http/https，不能带账密、查询串或锚点；`localhost` 允许。`models` 至少一个；`apiKey` 必填；`protocol` 不填按 key 前缀与域名自动推断。
- 手改文件时：某条配错了只丢那一条（启动 warn 一行），**同一个 id 出现多次则该 id 全部失效**（首赢末赢都是静默换端点，最贵的那种错）。设置页保存则是整份校验，任何一条非法就整次拒绝并告诉你是哪条。
- 切换器里点名了某个端点，这一轮**不带备用链**：打不通就如实报错，不会悄悄绕回主端点。
- 主端点仍然必填（写稿/复盘/选题路由依赖它），providers 不能单独撑起整个引擎。

正文配图与公众号草稿箱还需要在「设置 → 发布」配置图像服务，以及公众号 AppID/AppSecret（如果要实际推草稿箱）。密钥不会回显到页面。

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

# stdio MCP server
autocrew mcp
```

## MCP 与 OpenClaw

AutoCrew 的网页、CLI、OpenClaw 和 MCP 使用同一套能力注册表。

### Claude Code / 其他 MCP 客户端

先运行 `npm link`，再添加：

```json
{
  "mcpServers": {
    "autocrew": {
      "command": "autocrew",
      "args": ["mcp"]
    }
  }
}
```

MCP 提供工具、`autocrew://profile` / `autocrew://topics` / `autocrew://contents` 资源，以及写公众号、修改稿件、审稿、周复盘等提示词。

本地网页服务启动后还提供 Streamable HTTP MCP：`http://127.0.0.1:4317/mcp`。它只面向本机客户端，认证使用 `~/.autocrew/server-token` 中的 Bearer Token；不要把该 Token 发给他人。

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
