# AutoCrew — Week 1 阶段总结

## 一句话定位

**一个人的内容工作室。** AutoCrew 是一个 OpenClaw 插件，让个人创作者拥有一整个内容团队的能力——从选题调研、写作、审核到发布，全流程 AI 驱动。

## 第一证据：一条完整的内容创作工作流已跑通

```
用户说"帮我写一篇 vibe-coding 的文案"
  │
  ▼
情报调研（autocrew_intel pull）
  → web search + RSS + 趋势热榜
  → 自动收集 6+ 条相关信息源
  → 写入 references/ 作为创作素材
  │
  ▼
知识库同步（knowledge-sync）
  → 信息源自动合成 wiki 页面
  → 跨项目复利，下次写相关主题直接引用
  │
  ▼
两阶段创作（write-script）
  → Phase A: 搭结构骨架（核心观点 + 论证链 + Clock Theory 4 个节点）
  → 用户确认骨架
  → Phase B: 基于骨架填充正文，5 条 Operating System 原则驱动
  │
  ▼
自动保存 + 质量检查（autocrew_content save）
  → 自动去 AI 味（humanize）
  → HAMLETDEER 方法论合规检查（代码级强制）
  → Pipeline 完整性验证
  │
  ▼
内容审核（autocrew_review）
  → 敏感词扫描 + 质量评分
  │
  ▼
发布（autocrew_publish）
  → 小红书 / 抖音 / 微信公众号 / B站
```

## 核心数据

| 指标 | 数值 |
|------|------|
| npm 版本 | v0.3.3（8 天内发布 7 个版本） |
| 代码量 | 13,590 行 TypeScript |
| 测试 | 362 个，全绿 |
| AI 技能 | 30 个（调研/写作/审核/拆解/配置/决策...） |
| 工具 | 18 个 OpenClaw 注册工具 |
| Pipeline 阶段 | 7 个（intel → topics → drafting → production → published → wiki → trash） |

## Week 1 关键里程碑

### 已完成的能力模块

**1. 内容创作引擎（核心）**
- 两阶段创作流程：先搭骨架（核心观点 + Clock Theory 节点 + HKRR 维度）→ 用户确认 → 基于骨架填充正文
- 5 条 Operating System 原则驱动写作质量（EMPATHY FIRST / THEIR WORDS NOT YOURS / SHOW THE MOVIE / TENSION IS OXYGEN / THE CREATOR IS THE PROOF）
- HAMLETDEER 方法论合规检查在代码层强制执行，不依赖 LLM "自觉遵守"
- 修改即持久化——用户说"改一改"，修改版本自动写回 pipeline，不会只停留在聊天框

**2. Knowledge Wiki（知识复利层）**
- 每次调研产生的素材自动合成为 wiki 页面（实体/概念/对比）
- 跨项目、跨 session 积累，知识自动生长
- 写作时自动查 wiki，已积累的知识直接复用
- 三种信息源投喂：URL / 文本 / 本地 AI 工具 memory 文件

**3. 视频拆解（Omni 多模态）**
- 支持对标视频深度拆解，通过 MiMo-V2-Omni API 分析完整视频
- 四学科视角分析模板：传播学 / 心理学 / 内容结构 / 视听语言
- 可插拔视频采集器（MediaCrawl / Playwright / 手动）
- 拆解结果自动进入 intel + wiki，供后续创作引用

**4. Feature Triage（功能决策系统）**
- 四框架结构化决策：苏格拉底提问 / 第一性原理 / 奥卡姆剃刀 / 马斯洛需求
- 红队自检机制
- 决策报告自动存档到 docs/decisions/

**5. Configure（引导式服务配置）**
- 自动检测未配置的服务，显示功能影响
- 6 个模块逐步引导：Omni / 封面生成 / 视频采集 / TTS / 发布平台 / 情报源
- services.json 独立于创作者身份存储

### 修复的关键 Bug（让系统真正可用）

| Bug | 根因 | 修复方式 |
|-----|------|---------|
| 修改文案只在聊天框，不写回 pipeline | skill 没有指示 LLM 调用 update | 强制 revision 持久化指令 |
| draft.md 和 draft-v1.md 内容重复 | 两个文件同时写相同内容 | 改为"archive-on-revision"语义 |
| LLM 跳过 HAMLETDEER.md 方法论 | skill 指令是建议不是强制 | 代码层合规 gate（反模式检测） |
| LLM 用 Write 工具绕过 pipeline | 没有禁止直接写文件 | 三层防护（skill 禁令 + post-save 验证 + pipelineVerified flag） |
| topic 找不到（start 失败） | 两套 topic 存储系统不互通 | startProject fallback 到 legacy store |
| 直接推到 production 阶段 | advanceProject 无条件检查 | drafting→production gate（≥100 字） |

## 一个出乎意料的能力突破

**"规则堆叠"失败后发现的 Operating System 模式。**

最初我们用中文规则一条条约束 LLM（"不要用银弹"、"不要用维度"、"要做读者模拟"）。规则越加越多，LLM 遵循率反而下降。

突破点：我们把 ~60 条具体规则替换成 5 条英文原则（Operating System），放在 skill 文件最顶部。结果发现：
- 规则告诉 AI "不要做什么"（What NOT to do）— 只覆盖已知问题
- 原则告诉 AI "怎么思考"（How to think）— 自动覆盖未见过的场景
- 英文原则的 LLM 遵循率远高于中文规则

这个发现改变了我们设计所有 skill 的方式。

## 技术架构

```
┌─────────────────────────────────────────────────────┐
│                    OpenClaw Host                     │
│  (Claude Code / CLI / Discord Bot)                  │
├─────────────────────────────────────────────────────┤
│                   AutoCrew Plugin                    │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ 18 Tools │  │ 30 Skills│  │ Pipeline Store   │  │
│  │ (MCP)    │  │ (SKILL.md│  │ (7-stage state   │  │
│  │          │  │  prompts)│  │  machine)        │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ HAMLETDEER.md — Content Philosophy Engine    │   │
│  │ (HKRR / Clock Theory / Micro-Retention)      │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ Knowledge Wiki — Compounding Knowledge Layer │   │
│  │ (Auto-synthesis / Cross-reference / Lint)    │   │
│  └──────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────┤
│  Storage: ~/.autocrew/                              │
│  ├── creator-profile.json  (identity)               │
│  ├── services.json         (tool configs)           │
│  ├── pipeline/                                      │
│  │   ├── intel/    (raw research)                   │
│  │   ├── wiki/     (synthesized knowledge)          │
│  │   ├── topics/   (topic candidates)               │
│  │   ├── drafting/ (active projects)                │
│  │   ├── production/ → published/ → trash/          │
│  └── contents/     (legacy content store)           │
└─────────────────────────────────────────────────────┘
```

## 下一步（Week 2 计划）

1. **Configure skill 实现** — 让用户一键配好所有 API 和服务
2. **Video Teardown 实战验证** — 用 MiMo-V2-Omni 拆解真实对标视频
3. **Knowledge Wiki 冷启动** — 导入创作者现有 memory 和历史内容
4. **写作质量持续迭代** — 根据实际产出效果调整 Operating System 原则

## 项目链接

- GitHub: https://github.com/alextangson/AutoCrew
- npm: https://www.npmjs.com/package/autocrew
- 版本: v0.3.3
