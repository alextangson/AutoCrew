# AutoCrew

**中文新媒体创作者的 AI 数字员工。** 运行在 OpenClaw / Claude Code 上，从选题到发布全流程自动化。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-Plugin-blue)](https://openclaw.dev)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-MCP-purple)](https://claude.ai/code)

---

## 它能做什么

```
你：帮我找这周小红书的选题
AutoCrew：（搜索热榜 + 结合你的风格 → 推荐 5 个带评分的选题）

你：把第 2 个写成笔记
AutoCrew：（按你的写作风格生成 → 自动检查敏感词 → 输出标题备选 + hashtag）

你：太 AI 味了，改口语一点
AutoCrew：（去 AI 味处理 → 记录你的偏好 → 下次自动应用）

你：发到小红书
AutoCrew：（发布前 6 项检查 → 自动发布）
```

**Free 版完整工作流，零成本，零爬虫，零法律风险。**

---

## 安装

### OpenClaw（推荐）

```bash
openclaw plugins install autocrew
```

安装后直接在 OpenClaw 对话里使用，无需额外配置。

### Claude Code

```bash
git clone https://github.com/alextangson/AutoCrew.git
cd AutoCrew
npm install
```

在 `.claude/settings.json` 里添加 MCP server：

```json
{
  "mcpServers": {
    "autocrew": {
      "command": "npx",
      "args": ["tsx", "/path/to/AutoCrew/mcp/server.ts"]
    }
  }
}
```

### 初始化

```bash
openclaw crew init
```

创建 `~/.autocrew/` 数据目录，生成空的创作者档案。

---

## 工作流

### 1. 首次使用 — 自动引导

第一次触发任何功能时，AutoCrew 会自动读取你已有的 workspace 记忆，补问缺失信息（行业、受众、风格），然后继续你的原始请求。不打断，不强制。

### 2. 风格校准

```
你：风格校准
AutoCrew：（4 阶段深度校准 → 生成写作人格 → 写入 STYLE.md）
```

校准完成后，所有内容生成都会自动应用你的风格，一稿成型。

### 3. 选题调研

```
你：帮我找选题 / 这周写什么
AutoCrew：（搜索热榜 + 风格过滤 + 爆款评分 → 推荐 3-5 个选题）
```

Free 版使用公开搜索（知乎热榜、微博热搜、行业关键词）。Pro 版可直接爬取对标账号最新爆款。

### 4. 内容写作

```
你：写这个 / 帮我写
AutoCrew：（Hook-Body-CTA-Title 结构 → 结合你的风格和写作规则 → 输出草稿）
```

### 5. 内容审核

草稿完成后自动运行：
- 敏感词扫描（内置词库 + 平台特定限流词）
- 去 AI 味检查
- 质量评分（信息密度、hook 强度、CTA 清晰度）
- 输出修复建议

### 6. 多平台分发

```
你：改写成抖音版本
AutoCrew：（平台格式适配 → 生成平台专属标题 + hashtag → 保存为独立草稿）
```

同一个选题可以同时生成小红书版、抖音版，各自独立走审核和发布流程。

### 7. 发布

```
你：发布
AutoCrew：（6 项发布前检查 → 自动发布到小红书 / 抖音）
```

### 8. 学习循环

每次你修改内容，AutoCrew 自动记录 diff。累积 5 次同类修改后，自动提炼为写作规则，写入你的创作者档案，下次写作自动应用。

---

## Free vs Pro

| 功能 | Free | Pro |
|------|------|-----|
| 选题调研 | 公开搜索（知乎/微博热榜） | + 对标账号爬取 + 平台热榜 |
| 内容写作 | ✅ 完整工作流 | ✅ |
| 去 AI 味 | ✅ | ✅ |
| 敏感词检测 | ✅ | ✅ |
| 平台改写 | 小红书 + 抖音 | + 公众号 + 视频号 + B站 |
| 封面生成 | 3:4 比例 | + 16:9 + 4:3 |
| 发布 | 小红书 + 抖音 | 全平台 |
| 风格校准 | ✅ 4 阶段深度校准 | ✅ |
| 学习循环 | ✅ | ✅ |
| 对标账号监控 | ❌ | ✅ |
| 视频文案提取（ASR） | ❌ | ✅ |
| 数据分析报告 | ❌ | ✅ |
| 数字人 A-roll + TTS | ❌ | ✅ |

Pro 版通过云端 API 提供高级功能。[了解 Pro 版 →](https://autocrew.dev/activate)

---

## Skills（技能）

| Skill | 触发方式 |
|-------|---------|
| `onboarding` | 首次使用自动触发 |
| `style-calibration` | "风格校准" / "调风格" |
| `research` | "找选题" / "调研" / "这周写什么" |
| `topic-ideas` | "帮我想" / "想选题" |
| `spawn-planner` | "内容规划" / "做个计划" |
| `spawn-writer` | "写这个" / "帮我写" |
| `spawn-batch-writer` | "批量写" / "都写了" |
| `write-script` | 内部调用（由 spawn-writer 触发） |
| `platform-rewrite` | "改写" / "适配" / "发到XX平台" |
| `humanizer-zh` | "去AI味" / "润色" |
| `content-review` | "审核" / "检查" / "敏感词" |
| `pre-publish` | "发布前检查" |
| `publish-content` | "发布" / "发到小红书" |
| `xhs-cover-review` | "封面" / "生成封面" |
| `memory-distill` | 用户给内容反馈时自动触发 |
| `manage-pipeline` | "自动化" / "定时" |

---

## Tools（工具）

| Tool | 说明 |
|------|------|
| `autocrew_init` | 初始化数据目录和创作者档案 |
| `autocrew_topic` | 创建/列出选题 |
| `autocrew_research` | 选题调研（Free: web_search，Pro: 深度爬取） |
| `autocrew_content` | 草稿 CRUD + 状态流转 |
| `autocrew_humanize` | 中文去 AI 味 |
| `autocrew_rewrite` | 平台改写 + 批量多平台分发 |
| `autocrew_review` | 内容审核（敏感词 + 质量 + 去AI味检查） |
| `autocrew_pre_publish` | 发布前 6 项检查 |
| `autocrew_cover_review` | 小红书封面 A/B/C 审核 |
| `autocrew_asset` | 素材管理（封面/B-roll/字幕） |
| `autocrew_pipeline` | 自动化流水线管理 |
| `autocrew_publish` | 发布到平台 |
| `autocrew_memory` | 反馈记录和记忆读取 |
| `autocrew_status` | 流水线状态概览 |
| `autocrew_pro_status` | Pro 状态 + 创作者档案完整度 |

---

## CLI 命令

```bash
openclaw crew init                          # 初始化
openclaw crew status                        # 流水线概览
openclaw crew profile                       # 查看创作者档案
openclaw crew upgrade                       # 查看/激活 Pro 版
openclaw crew upgrade --key <your-key>      # 激活 Pro

openclaw crew topics                        # 列出选题
openclaw crew contents                      # 列出草稿
openclaw crew assets <content-id>           # 列出素材
openclaw crew versions <content-id>         # 版本历史

openclaw crew humanize <content-id>         # 去 AI 味
openclaw crew adapt <content-id> <platform> # 平台改写
openclaw crew cover-review <content-id>     # 生成封面候选
openclaw crew approve-cover <content-id> <a|b|c>  # 审批封面

openclaw crew learn <content-id> --signal edit --feedback "太正式了"
openclaw crew memory                        # 查看记忆
openclaw crew pipelines                     # 列出流水线
openclaw crew templates                     # 流水线模板
```

---

## 数据存储

所有数据本地存储，不上传任何内容：

```
~/.autocrew/
├── creator-profile.json    # 创作者档案（行业、受众、写作规则）
├── STYLE.md                # 写作风格档案
├── topics/                 # 选题库
├── contents/               # 内容项目
│   └── content-xxx/
│       ├── meta.json       # 元数据 + 状态 + 素材索引
│       ├── draft.md        # 当前草稿
│       ├── assets/         # 封面、B-roll、字幕
│       └── versions/       # 版本历史（v1.md, v2.md...）
├── learnings/
│   ├── edits/              # 每次修改的 diff 记录
│   └── rules.json          # 自动提炼的写作规则
├── sensitive-words/        # 敏感词库（内置 + 自定义）
├── pipelines/              # 自动化流水线配置
└── .pro                    # Pro API key（如已激活）
```

---

## 开发

```bash
git clone https://github.com/alextangson/AutoCrew.git
cd AutoCrew
npm install

# OpenClaw 本地开发
openclaw plugins install --link .

# Claude Code 本地开发
# 在 .claude/settings.json 里配置 MCP server（见上方安装说明）
```

---

## License

MIT © [alextangson](https://github.com/alextangson)
