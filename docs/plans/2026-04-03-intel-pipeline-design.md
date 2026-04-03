# AutoCrew 情报引擎 + 内容管线设计文档

> 日期：2026-04-03
> 状态：已确认，待实现

## 背景

AutoCrew 当前的选题调研能力依赖单一 web search，信息源深度不够。好内容的前提是好信息 — garbage in, garbage out。本设计将选题系统升级为完整的情报采集 → 选题提炼 → 内容管线流转体系。

## 设计目标

1. 多源情报采集，为创作者持续积累高质量信息
2. 从情报中智能提炼选题，维护常青选题池
3. 本地文件夹结构映射内容生命周期，支持 Obsidian/Notion 等工具直接访问
4. 项目自包含，版本留痕，平台适配内聚

---

## 一、本地文件夹结构

```
~/.autocrew/
├── pipeline/                          # 内容管线
│   ├── intel/                         # 情报库（按领域）
│   │   ├── {领域}/
│   │   │   └── YYYY-MM-DD-{slug}.md
│   │   ├── _archive/                  # 过期情报归档
│   │   └── _sources/                  # 订阅源配置
│   │       ├── rss.yaml
│   │       ├── accounts.yaml
│   │       ├── keywords.yaml
│   │       └── trends.yaml
│   │
│   ├── topics/                        # 选题池（单文件）
│   │   └── {领域}-{slug}.md
│   │
│   ├── drafting/                      # 创作中（项目文件夹）
│   │   └── {project-name}/
│   │       ├── meta.yaml
│   │       ├── draft-v1.md
│   │       ├── draft-v2.md
│   │       ├── draft.md               # 始终指向最新版
│   │       └── references/
│   │
│   ├── production/                    # 制作中（排版/剪辑）
│   │   └── {project-name}/
│   │       ├── meta.yaml
│   │       ├── draft.md               # 定稿
│   │       ├── assets/                # B-roll、封面、字幕
│   │       ├── references/
│   │       └── platform/              # 各平台适配版本
│   │           ├── xiaohongshu/
│   │           │   └── adapted.md
│   │           └── bilibili/
│   │               └── adapted.md
│   │
│   ├── published/                     # 已发布
│   │
│   └── trash/                         # 回收站
│
├── creator-profile.json               # 不变
├── STYLE.md                           # 不变
├── learnings/                         # 不变
└── sensitive-words/                   # 不变
```

### 设计决策

- 情报文件名 `YYYY-MM-DD-slug.md`：日期在文件名方便排序，不用日期文件夹避免膨胀
- `topics/` 阶段是单文件，`drafting/` 阶段才展开为项目文件夹
- 项目文件夹始终只有一份，不跨文件夹复制
- 平台适配版本收在项目内部 `platform/` 子文件夹
- `ready/` 平台文件夹根据 `creator-profile.json` 的 `platforms` 动态生成
- 所有 Markdown 使用 YAML frontmatter 存元数据，Obsidian 原生支持

---

## 二、情报引擎采集架构

### 信息源层级

```
Source Layer（信息源）
├── Web Search（现有，增强）
├── RSS 订阅（新增）
├── 竞品/账号监控（新增）
└── 平台热榜/趋势（新增）
        │
        ▼
Collector（采集器统一接口）
normalize → deduplicate → score → archive
        │
        ▼
intel/{领域}/YYYY-MM-DD-slug.md
```

### 采集器详情

**1. Web Search（增强）**

搜索结果先落地为情报文件，再从情报中提炼选题。多维度查询：
- 行业动态：`"{领域} 最新进展 {年月}"`
- 争议话题：`"{领域} 争议 讨论"`
- 数据报告：`"{领域} 报告 数据 {年}"`
- 实操教程：`"{keyword} 教程 踩坑"`

**2. RSS 订阅**

配置文件 `_sources/rss.yaml`：
```yaml
feeds:
  - url: https://sspai.com/feed
    domain: 效率工具
    tags: [生产力, 工具测评]
```

采集逻辑：拉取 feed → 解析条目 → LLM 判断领域相关度（>0.6 才入库）→ 生成情报 Markdown。

**3. 竞品/账号监控**

配置文件 `_sources/accounts.yaml`：
```yaml
accounts:
  - platform: xiaohongshu
    name: "花爷梦呓换"
    id: "xxx"
    domain: 职场
```

复用现有 browser-cdp 适配器抓取竞品最新内容。无浏览器时降级跳过。

**4. 平台热榜/趋势**

配置文件 `_sources/trends.yaml`：
```yaml
trends:
  # 国内
  - source: weibo_hot
    enabled: true
  - source: zhihu_hot
    enabled: true
  - source: douyin_hot
    enabled: true
  # 国际
  - source: twitter_trending
    enabled: true
    region: US
  - source: reddit
    enabled: true
    subreddits: [programming, ChatGPT]
  - source: hackernews
    enabled: true
    min_score: 100
  - source: producthunt
    enabled: true
  - source: google_trends
    enabled: true
    keywords: [AI coding]
  # 行业垂直
  - source: github_trending
    enabled: true
  - source: arxiv
    enabled: false
    categories: [cs.AI]
```

信息源根据用户 `creator-profile.json` 的 `industry` 字段推荐，不相关的不出现。预置领域-信息源映射维护在 `source-presets.yaml` 中。

国际内容由 LLM 自动翻译摘要为中文后归档，原文链接保留在 `source_url`。

### 情报文件格式

```markdown
---
title: Cursor 发布 Agent 模式
domain: AI编程
source: rss
source_url: https://sspai.com/post/xxx
collected_at: 2026-04-03T10:30:00+08:00
relevance: 0.85
tags: [Cursor, AI编程, IDE]
expires_after: 30d
---

## 摘要
...

## 关键信息
- ...

## 选题潜力
- ...
```

### 触发方式

- **被动模式（A）**：用户执行 `autocrew research` 时，四种采集器并行跑
- **订阅模式（B）**：用户执行 `autocrew intel pull` 手动拉取订阅源更新

### 去重与过期

- 去重：新情报入库前对比标题相似度（>0.8 视为重复，合并）
- 过期：frontmatter `expires_after` 控制，默认 30 天。过期移到 `intel/_archive/`

---

## 三、情报 → 选题提炼

### 流程

```
intel/{领域}/*.md
      │  autocrew topics generate
      ▼
LLM 提炼层
  1. 读取最近 N 天未过期情报
  2. 结合 creator-profile（领域、受众痛点、风格边界、竞品已发内容）
  3. 生成选题候选，每个附带：切入角度、情报来源、平台适配性、评分
      │
      ▼
topics/{选题}.md
```

### 选题文件格式

```markdown
---
title: "Cursor Agent vs Claude Code：AI编程双雄深度对比"
domain: AI编程
score:
  heat: 82
  differentiation: 75
  audience_fit: 90
  overall: 83
formats: [image-text, video]
suggested_platforms: [xiaohongshu, bilibili]
created_at: 2026-04-03
intel_refs:
  - intel/AI编程/2026-04-03-cursor-agent模式.md
  - intel/AI编程/2026-04-01-claude-code-hooks.md
---

## 切入角度
1. ...

## 目标受众共鸣点
- ...

## 参考素材
- ...
```

### 两种使用路径

- **情报 → 选题**：`autocrew topics generate` 从情报库自动提炼
- **选题 → 情报**：`autocrew research --topic "xxx"` 围绕选题反向深度采集

### 选题池维护

- 每次 `intel pull` 后提示用户是否刷新选题池
- 超过 14 天未选中的选题热度自动衰减，低于阈值移入 `trash/`
- 用户可在 Obsidian 里直接编辑/删除/手动创建选题

---

## 四、管线流转机制

### 迁移命令

```bash
autocrew start <topic>           # topics/ → drafting/   展开项目文件夹
autocrew advance <project>       # drafting/ → production/
autocrew ready <project> --platform xiaohongshu,bilibili
autocrew publish <project> --platform xiaohongshu
autocrew trash <project>         # 任意阶段 → trash/
autocrew restore <project>       # trash/ → 原阶段
```

### `autocrew start` 行为

将选题单文件展开为项目文件夹：
```
topics/AI编程-cursor对比.md
      │  autocrew start
      ▼
drafting/AI编程-cursor对比/
├── meta.yaml
├── draft-v1.md          # 基于选题自动生成初稿骨架
├── draft.md             # → draft-v1.md
└── references/          # 从 intel/ 复制关联情报
```

### meta.yaml 结构

```yaml
title: "Cursor Agent vs Claude Code 深度对比"
domain: AI编程
format: image-text
created_at: 2026-04-03T10:00:00+08:00
source_topic: topics/AI编程-cursor对比.md
intel_refs:
  - intel/AI编程/2026-04-03-cursor-agent模式.md

versions:
  - file: draft-v1.md
    created_at: 2026-04-03T14:00:00+08:00
    note: "系统初稿"
  - file: draft-v2.md
    created_at: 2026-04-03T16:30:00+08:00
    note: "用户反馈：开头太平，改为故事切入"
current: draft-v2.md

history:
  - stage: topics
    entered: 2026-04-03T10:00:00+08:00
  - stage: drafting
    entered: 2026-04-03T14:00:00+08:00
  - stage: production
    entered: 2026-04-04T09:00:00+08:00

platforms:
  xiaohongshu:
    format: carousel
    status: ready
  bilibili:
    format: video
    status: drafting
```

### 多平台设计

- 项目文件夹始终只有一份，不复制
- 平台适配版本在项目内部 `platform/{平台}/` 管理
- 各平台可在不同阶段（meta.yaml 的 `platforms` 字段追踪）
- 全部平台 published 后整个文件夹才移入 `published/`
- Obsidian 里拖动文件也生效，`autocrew status` 会检测并同步

### 版本留痕

- 每次修改不覆盖，生成 `draft-v{N}.md`
- `draft.md` 始终指向最新版
- `meta.yaml` 的 `versions` 数组记录每个版本的时间和修改原因
- 历史数据可用于后续创作者数据分析

---

## 五、CLI 命令与工具接口

### CLI 命令

```bash
# 情报采集
autocrew intel pull                    # 拉取所有订阅源
autocrew intel pull --source rss       # 只拉取 RSS
autocrew intel list                    # 情报库概览
autocrew intel list --domain AI编程    # 按领域筛选
autocrew intel clean                   # 清理过期情报

# 选题管理
autocrew topics generate               # 从情报库提炼选题
autocrew topics generate --domain AI编程
autocrew topics list
autocrew topics list --sort score

# 管线流转
autocrew start <topic>
autocrew advance <project>
autocrew ready <project> --platform xiaohongshu,bilibili
autocrew publish <project> --platform xiaohongshu
autocrew trash <project>
autocrew restore <project>

# 调研
autocrew research --keyword <keyword>  # 增强：情报优先落地
autocrew research --topic <topic>      # 新增：反向深度调研

# 全局
autocrew status                        # 管线看板
autocrew setup sources                 # 配置信息源
```

CLI 命令保持完整语义，不缩写。主要使用场景是 Agent 通过自然语言理解后调用。

### 新增 MCP 工具

```
autocrew_intel        # action: pull / list / clean
autocrew_pipeline     # action: start / advance / ready / publish / trash / restore / status
```

### 现有工具调整

- `autocrew_research`：`discover` 改为情报优先落地，新增 `deep` action
- `autocrew_topic`：`create` 支持从情报引用生成，`list` 增加排序筛选

### 新增 Skill

```
skills/intel-pull/SKILL.md         # "最新资讯" / "拉取情报"
skills/intel-digest/SKILL.md       # "情报摘要" / "本周洞察"
skills/pipeline-status/SKILL.md    # "项目进度" / "看板"
```

### 现有 Skill 调整

- `research/SKILL.md`：调研流程改为情报优先
- `topic-ideas/SKILL.md`：从情报库读取素材辅助头脑风暴

---

## 六、数据迁移

现有 `~/.autocrew/topics/` 和 `~/.autocrew/contents/` 的数据需一次性迁移：

1. `topics/*.json` → `pipeline/topics/*.md`（JSON 转 Markdown + frontmatter）
2. `contents/content-{id}/` → `pipeline/{stage}/{project-name}/`（根据 meta.json status 决定目标阶段）
3. 迁移命令：`autocrew migrate`（一次性，幂等）
4. 旧目录保留为备份直到用户手动删除

---

## 改动范围汇总

| 模块 | 改动 |
|------|------|
| 新增：情报引擎 | 4 种采集器 + 统一归档 + 去重过期 |
| 新增：管线文件夹 | `pipeline/` 6 个阶段 + 文件夹迁移逻辑 |
| 重构：选题生成 | 从直接搜索改为情报 → 提炼两步 |
| 重构：项目结构 | 自包含文件夹 + 版本留痕 + 平台适配 |
| 新增：CLI 命令 | `intel`, `start`, `advance`, `ready`, `publish` 等 |
| 新增：MCP 工具 | `autocrew_intel`, `autocrew_pipeline` |
| 迁移：现有数据 | 旧 `topics/` + `contents/` → 新 `pipeline/` |

## 未来扩展（不在本次范围）

- **C 模式智能推送**：cron 定时拉取 + 主动通知
- **创作者数据分析**：基于 history 和版本数据的创作频率、效率分析
- **B-roll 自动生成**：图文排版 + 视频素材源生成
- **自动剪辑**：production 阶段的视频自动化
