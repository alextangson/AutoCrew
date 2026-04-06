# 功能决策：Knowledge Wiki（知识复利层）

## 结论
**做。** 以最小形式切入 — 1 个 tool action 扩展 + 1 个新 skill + 1 处现有 skill 修改。填补 Level 3 质量层纵深缺口，是 references 调研流程的自然延伸。

## 提案原始描述
用户提出参考 Karpathy 的 llm-wiki gist（三层架构：raw → wiki → schema），在 AutoCrew 中加入知识库功能，让创作过程中积累的素材能跨项目复利、持续生长。

## 分析过程

### 🔍 苏格拉底提问 — 本质问题
- 根本问题：AutoCrew 目前的知识是"用完即弃"的 — 每次创作产生的调研素材（references/）、情报（intel/）、teardowns 都是孤岛，不会跨项目积累和交叉关联。创作者需要一个持续复利的知识层：既能自动索引历史积累，又能随着新信息源的投喂主动生长出新的合成洞察。
- 关键追问与回答：
  - Q: 你现在知识怎么流转的？A: 每次都得重新搜和整理
  - Q: 你理想中的"复利"是什么样？A: 既要历史素材自动索引，又要持续维护的领域知识库

### 🧱 第一性原理 — 需求拆解
| 能力单元 | 判定 | 理由 |
|----------|------|------|
| 历史素材全局索引 | ⚠️ 部分覆盖 | intel 层有跨项目能力，references/ 按项目隔离无全局索引 |
| 用户主动投喂信息源 | ⚠️ 部分覆盖 | autocrew_intel 有"拉"模式（pull），缺"推"模式（用户手动丢 URL） |
| 知识合成层 | ✅ 真实缺口 | 当前只有一级材料（intel 原始情报、references 信源摘要），没有二级合成产物（实体页、概念页、对比页） |
| 交叉关联 + 自动更新 | ✅ 真实缺口 | 每条 intel 是独立 markdown，没有互引、没有 lint 机制 |
| 创作时自动调用知识库 | ⚠️ 部分覆盖 | write-script Step 5.5 已查 intel 库，只需加"查 wiki 合成页"入口 |

- 借鉴偏差检测：有，但合理。想法来自 Karpathy gist，但 AutoCrew 的场景有关键差异 — 知识库天然以内容创作为终点，intel → topics → drafting 流程确实缺少中间合成层。不是"因为别人有所以也要"，而是现有管道的结构性缺口。

### 🪒 奥卡姆剃刀 — 最简形式
- 推荐形式：
  1. **扩展 `autocrew_intel`** 加 `action: "ingest"` — 用户主动投喂入口
  2. **新 skill `knowledge-sync`** — 编排"读新 intel → 更新/创建 wiki 合成页 → 更新 index.md → 写 log.md → lint 检查"
  3. **新目录 `~/.autocrew/data/pipeline/wiki/`** — 存放合成页面（entity/、concept/、comparison/、index.md、log.md）
  4. **扩展 write-script Step 5.5** — 加"查 wiki/index.md → 读相关合成页 → 写入 references/"步骤
- 砍掉的部分：
  - Schema 层（CLAUDE.md 配置）— AutoCrew 已有 SKILL.md 体系
  - Obsidian 集成 — wiki/ 本身就是 markdown 文件夹，用户想用 Obsidian 随时可以打开
  - qmd 搜索引擎 — 初期页面量不大，grep + index.md 够用
  - Marp 演示文稿生成 — 和内容创作无关
- 最小可行范围：1 个 tool action 扩展 + 1 个新 skill + 1 处现有 skill 修改。不需要新 tool、新模块、新数据库。

### 📊 马斯洛需求分析 — 价值定位
- 需求层级：Level 3 — 质量层
- 当前缺口匹配度：填补当前缺口。references 调研流程（Step 5.5）刚上线，解决了"有没有素材"，知识库解决"素材能不能复利"，是 Level 3 的纵深补完，不是跳级。
- 优先级建议：立即做。references 是入口，知识库是蓄水池，入口刚修好但水流进来又流走了，蓄水池是自然下一步。

### 🔴 红队自检

| # | 不做的理由 | 反驳 | 强度 |
|---|-----------|------|------|
| 1 | wiki 合成层质量取决于 LLM 合成能力，可能产出低质量页面误导创作 | 可控：wiki 是 markdown 文件可人工审阅，lint 步骤标记矛盾。比"没有合成层每次从零搜"好。风险存在但收益更大。 | 有效反驳 |
| 2 | 维护成本大，每次 ingest 要更新 10-15 个页面，token 消耗高 | Karpathy 方案已验证可行。可做增量更新（只更新相关页面），不需全量重建。token 成本可控。 | 有效反驳 |
| 3 | 当前用户领域集中（AI 落地），wiki 可能几十页就饱和，复利效果有限 | 合成层价值不在量大而在交叉关联和矛盾检测，几十页也有价值。且开源后其他用户领域更分散。 | 勉强有效，接受风险 |

红队结论：3 条反驳均成立，维持"做"。

## 实现建议
- 形式：1 个 tool action 扩展 + 1 个新 skill + 1 处现有 skill 修改
- 依赖的现有组件：
  - `autocrew_intel`（扩展 ingest action）
  - `src/storage/pipeline-store.ts`（wiki 目录初始化）
  - `skills/write-script/SKILL.md`（Step 5.5 加 wiki 查询）
- 主要风险：
  - LLM 合成质量不稳定 → 通过 lint + 用户审阅缓解
  - Token 成本 → 增量更新策略
- 建议下一步：brainstorming → writing-plans → 实现。优先级：knowledge-sync skill + wiki 目录结构 → intel ingest action → write-script 集成

## 参考
- [Karpathy llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## 元数据
- 日期：2026-04-06
- 提案人：user
- 复杂度评估：中等
