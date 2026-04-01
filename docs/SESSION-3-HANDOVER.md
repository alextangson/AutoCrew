# Session 3 Handover

## Session 2 完成内容

修改 4 个文件：

### 1. `src/storage/local-store.ts` — 核心数据模型 + 状态机 + 多平台分发

**Content 接口扩展：**
- `ContentStatus` 类型：11 个状态值 `topic_saved | drafting | draft_ready | reviewing | revision | approved | cover_pending | publish_ready | publishing | published | archived`
- `LegacyContentStatus` + `normalizeLegacyStatus()` — 向后兼容旧的 `draft`/`review`
- 新增字段：`siblings: string[]`、`hashtags: string[]`、`publishedAt: string | null`、`publishUrl: string | null`、`performanceData: Record<string, number>`
- `saveContent()` 和 `updateContent()` 已适配所有新字段

**状态流转函数：**
- `transitionStatus(contentId, targetStatus, opts?, dataDir?)` — 带校验的状态转换
  - `STATE_TRANSITIONS` 定义合法流转路径（对应 PRD §13.2 状态图）
  - 自动触发：进入 `revision` 时记录 diff 到 `learnings/edits/`
  - 自动触发：到达 `draft_ready` 时返回提示（建议自动进入 reviewing）
  - 进入 `published` 时自动设置 `publishedAt`
  - 支持 `force` 参数跳过校验
- `getAllowedTransitions(status)` — 查询当前状态的合法下一步

**多平台分发：**
- `createPlatformVariant(topicId, platform, opts?, dataDir?)` — 从 topic 创建平台版本
  - 自动查找已有 siblings 并建立双向关联
  - 检查同平台重复创建
- `listSiblings(contentId, dataDir?)` — 查看同 topic 的所有平台版本
  - 优先用 `siblings` 字段，fallback 用 `topicId` 查找

### 2. `src/tools/content-save.ts` — tool 层扩展

- 新增 4 个 action：`transition`、`create_variant`、`siblings`、`allowed_transitions`
- schema 新增字段：`hashtags`、`siblings`、`publish_url`、`performance_data`、`target_status`、`force`、`diff_note`
- status enum 扩展为 11+2（含 legacy）
- `save` action 默认 status 从 `draft` 改为 `draft_ready`

### 3. `mcp/server.ts` — MCP schema 同步

- `autocrew_content` 的 `inputSchema` 完全同步新字段和 action

### 4. `index.ts` — OpenClaw 入口同步

- `autocrew_content` tool description 更新

---

## Session 3 建议任务

**主题：敏感词过滤 + content-review skill + Learnings 增强**

对应 PRD 章节：六（内容审核）+ 七（Learnings 学习系统增强）

### 需要做的事

1. **敏感词过滤模块** `src/modules/filter/sensitive-words.ts`
   - 加载内置词库 `src/data/sensitive-words-builtin.json` + 用户自定义 `~/.autocrew/sensitive-words/custom.txt`
   - `scanText(text)` → 返回命中词列表 + 建议替换
   - 平台特定限流词支持

2. **content-review skill** `skills/content-review/SKILL.md`
   - 整合：敏感词扫描 + 去 AI 味检查 + 质量评分
   - 输出审核报告 + 一键修复建议
   - 与状态机联动：`draft_ready → reviewing → approved/revision`

3. **Learnings 增强**
   - `src/modules/learnings/diff-tracker.ts` — diff 追踪（before/after 对比）
   - `src/modules/learnings/rule-distiller.ts` — 累积 5+ 次同类修改后自动提炼规则
   - 规则写入 `creator-profile.json` 的 `writingRules` 字段

4. **内置敏感词库** `src/data/sensitive-words-builtin.json`
   - 基础中文敏感词 + 各平台限流词

### 需要读取的文件

- `docs/PRD-v2.md` 章节六、七
- `src/storage/local-store.ts`（已更新）
- `src/modules/profile/creator-profile.ts`（writingRules 字段）
- `src/modules/humanizer/zh.ts`（去 AI 味逻辑，review 需要调用）
