# Session 2 Handover

## Session 1 完成内容

新增 5 个文件，修改 3 个文件：

### 新增文件

1. `src/modules/pro/gate.ts` — Pro 功能门控
   - `readProKey()` / `saveProKey()` / `removeProKey()` — 管理 `~/.autocrew/.pro` 文件
   - `getProStatus()` — 本地检测 Pro 状态（不联网）
   - `requirePro(featureName)` — 在 tool execute 中调用，Free 用户返回升级提示
   - `proGateResponse(featureName, freeAlternative)` — 带 Free 替代方案的升级提示
   - `PRO_FEATURES` 常量 + `isProFeature()` 判断

2. `src/modules/pro/api-client.ts` — Pro API 客户端骨架
   - 完整的 Pro API endpoint 封装（认证、选题爬虫、对标账号、视频转写、数据分析、封面、TTS、数字人）
   - 统一的 `ProApiResponse<T>` 返回格式，含 usage 配额信息
   - 基于 `fetch` 的 HTTP 客户端，支持 `AUTOCREW_PRO_API_URL` 环境变量

3. `src/modules/profile/creator-profile.ts` — 创作者 Profile 读写
   - `CreatorProfile` 完整类型定义（industry, platforms, audiencePersona, writingRules, styleBoundaries, competitorAccounts, performanceHistory）
   - CRUD: `loadProfile()` / `saveProfile()` / `initProfile()` / `updateProfile()`
   - 便捷方法: `addWritingRule()` / `addCompetitor()` / `addPerformanceEntry()`
   - `detectMissingInfo()` — 检测缺失字段，供 onboarding skill 使用

4. `skills/onboarding/SKILL.md` — 首次引导 skill 定义
   - 3 步流程：读取宿主 MEMORY → 补问缺失信息 → 继续原始任务
   - 可跳过、不阻断、渐进式收集

5. `src/tools/init.ts` — autocrew init 命令核心逻辑
   - 创建 `~/.autocrew/` 完整目录结构（9 个子目录）
   - 初始化空 `creator-profile.json` 和 `STYLE.md`
   - 幂等操作，重复运行安全

### 修改文件

6. `openclaw.plugin.json` — 更新 configSchema
   - 移除 `tikhub_token`（不再是 Free 版功能）
   - 新增 `pro_api_key` 和 `pro_api_url`
   - 更新 description 说明 Free/Pro 分层

7. `index.ts` — OpenClaw 入口
   - 新增 import: init, pro gate, pro api-client, creator-profile
   - 新增 CLI 命令: `crew init` / `crew upgrade` / `crew profile`

8. `mcp/server.ts` — Claude Code MCP 入口
   - 新增 import: init, pro gate, creator-profile
   - 新增 MCP tools: `autocrew_init` / `autocrew_pro_status`

---

## Session 2 任务

**主题：内容状态机 + 多平台分发数据模型**

对应 PRD 章节：十三（内容生命周期状态机）+ 十四（多平台分发数据模型）

### 需要做的事

1. **扩展 `Content` 接口**（`src/storage/local-store.ts`）
   - status 从 4 个值扩展为 10 个：`topic_saved | drafting | draft_ready | reviewing | revision | approved | cover_pending | publish_ready | publishing | published | archived`
   - 新增字段：`siblings: string[]`（同 topic 的其他平台版本 ID）
   - 新增字段：`hashtags: string[]`
   - 新增字段：`publishedAt: string | null`
   - 新增字段：`publishUrl: string | null`
   - 新增字段：`performanceData: Record<string, number>`

2. **实现状态流转函数**
   - `transitionStatus(contentId, targetStatus)` — 带校验的状态转换
   - 自动触发规则：`draft_ready → reviewing` 自动运行
   - `revision` 状态自动记录 diff 到 learnings

3. **实现多平台分发**
   - `createPlatformVariant(topicId, platform)` — 从 topic 创建特定平台的 content
   - 自动设置 `siblings` 关联
   - `listSiblings(contentId)` — 查看同 topic 的所有平台版本

4. **更新 `content-save.ts` tool**
   - 支持新的 status 值
   - 支持 siblings / hashtags / publishedAt / publishUrl 字段

5. **更新 MCP server 的 content tool schema**
   - 同步新字段到 inputSchema

### 需要读取的文件

- `docs/PRD-v2.md` 章节十三、十四（已在本 session 读过，可直接参考）
- `src/storage/local-store.ts`（已在本 session 读过）
- `src/tools/content-save.ts`（需要读取）
