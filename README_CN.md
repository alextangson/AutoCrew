# AutoCrew

**一个人的 AI 内容工作室 -- 从选题到发布，全流程自动化。**

[English](README.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/autocrew.svg)](https://www.npmjs.com/package/autocrew)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

AutoCrew 是为中文新媒体创作者打造的 AI 内容运营工具。覆盖选题调研、文案撰写、敏感词审核、去 AI 味、多平台改写、一键发布的完整流程。

支持独立 CLI 使用，也可作为 [Claude Code](https://claude.ai/code) 或 [OpenClaw](https://openclaw.dev) 的插件。

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

---

## 快速开始

```bash
npm install -g autocrew
autocrew init
autocrew research
```

`init` 创建本地数据目录（`~/.autocrew/`），`research` 从公开来源发现热门选题。

---

## 核心功能

### 选题调研
- 从公开来源发现热门选题（知乎热榜、微博热搜、行业关键词）
- 基于你的领域和受众自动评分
- 灵感源监控管道

### 内容写作
- 风格校准 -- 4 阶段深度校准，学习你的表达方式
- Hook-Body-CTA-Title 结构，针对中文社媒优化
- 多平台改写 -- 同一选题生成小红书版、抖音版，各自独立

### 内容审核
- 敏感词扫描（内置词库 + 平台特定限流词）
- 去 AI 味（去除 AI 生成痕迹）
- 质量评分：信息密度、hook 强度、CTA 清晰度

### 发布
- 支持平台：小红书、抖音、微信视频号、微信公众号、B站
- 发布前 6 项自动检查
- 封面生成 + A/B/C 候选审核

### 学习循环
- 自动记录你的每次修改
- 同类修改累积 5 次后，自动提炼为写作规则
- 下次写作时自动应用

### Web 控制台
- 内置 Web UI，可视化管理内容
- 文案编辑器 + 时间轴式视频制作
- 支持导出剪映工程文件

---

## 运行原理

AutoCrew 完全运行在你的本地机器上。所有内容、草稿、创作者档案都存储在 `~/.autocrew/`，不会上传任何数据。

核心是独立的 Node.js CLI，包含 20+ 工具和 15+ 技能。薄薄的插件层让它可以作为 Claude Code MCP 服务器或 OpenClaw 扩展使用 -- 但不依赖任何一个。

```
~/.autocrew/
├── creator-profile.json    # 创作者档案（领域、受众、写作规则）
├── STYLE.md                # 写作风格档案
├── topics/                 # 选题库
├── contents/               # 内容项目
│   └── content-xxx/
│       ├── meta.json       # 元数据 + 状态 + 素材索引
│       ├── draft.md        # 当前草稿
│       ├── timeline.json   # 视频时间轴
│       └── versions/       # 版本历史
└── learnings/              # 修改记录 + 提炼的写作规则
```

---

## 搭配 Claude Code 使用

在 Claude Code 设置中添加 MCP 服务器：

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

然后直接用自然语言对话 -- "帮我找选题"、"写成小红书笔记"、"去 AI 味"。

## 搭配 OpenClaw 使用

```bash
openclaw plugins install autocrew
```

安装后直接在 OpenClaw 对话里使用，无需额外配置。

---

## CLI 命令

| 命令 | 说明 |
|------|------|
| `autocrew init` | 初始化数据目录和创作者档案 |
| `autocrew status` | 流水线概览 |
| `autocrew research` | 发现热门选题 |
| `autocrew topics` | 列出选题 |
| `autocrew start <topic>` | 从选题开始创作 |
| `autocrew contents` | 列出内容项目 |
| `autocrew humanize <id>` | 去 AI 味 |
| `autocrew adapt <id> <platform>` | 平台改写 |
| `autocrew review <id>` | 内容审核（敏感词 + 质量） |
| `autocrew pre-publish <id>` | 发布前 6 项检查 |
| `autocrew profile` | 查看创作者档案 |
| `autocrew learn <id> --signal edit --feedback "太正式了"` | 记录反馈 |
| `autocrew intel` | 灵感源管理 |

运行 `autocrew --help` 查看完整命令列表。

---

## Free vs Pro

| 功能 | Free | Pro |
|------|------|-----|
| 选题调研 | 公开搜索（知乎/微博热榜） | + 对标账号爬取 + 平台热榜 |
| 内容写作 | 完整工作流 | 完整工作流 |
| 去 AI 味 | 支持 | 支持 |
| 敏感词检测 | 支持 | 支持 |
| 平台改写 | 小红书 + 抖音 | + 公众号 + B站 |
| 封面生成 | 3:4 | + 16:9 + 4:3 |
| 发布 | 小红书 + 抖音 | 全平台 |
| 风格校准 | 支持 | 支持 |
| 学习循环 | 支持 | 支持 |
| 对标账号监控 | 不支持 | 支持 |
| 视频 ASR 提取 | 不支持 | 支持 |
| 数据分析报告 | 不支持 | 支持 |

---

## 开发

```bash
git clone https://github.com/alextangson/AutoCrew.git
cd AutoCrew
npm install
npm test        # 341 个测试
```

启动 Web 控制台开发模式：

```bash
cd web && npm run dev
```

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解贡献指南。

---

## License

MIT &copy; [alextangson](https://github.com/alextangson)
