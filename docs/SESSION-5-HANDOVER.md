# Session 4 完成内容

新增 3 个文件，修改 2 个文件：

## 1. `src/tools/review.ts` — autocrew_review tool

整合 3 层审核能力的统一入口：

- `full_review`：敏感词扫描 + 去 AI 味检查（humanizer-zh dry-run）+ 质量评分，输出完整审核报告
- `scan_only`：仅敏感词扫描
- `quality_score`：仅质量评分（信息密度 / Hook 强度 / CTA 清晰度 / 可读性，满分 100）
- `auto_fix`：自动应用敏感词替换 + humanizer-zh 修复，可选 save_back

状态机联动：
- 传入 content_id 时，full_review 自动触发状态流转
- 全部通过 → `reviewing → approved`
- 未通过 → `reviewing → revision`（附 diff_note）

已注册到 `index.ts`（OpenClaw）和 `mcp/server.ts`（Claude Code MCP）。

## 2. `src/modules/research/free-engine.ts` — Free 版选题引擎

纯 web_search 选题，零爬虫零第三方 API：

- `buildSearchQueries(keyword, industry, platforms)` → 生成 3-5 条搜索查询
- `scoreCandidate(candidate, profile, keyword)` → 爆款评分（标题吸引力 + 话题热度 + 用户匹配度，0-100）
- `filterByStyle(candidates, profile)` → 风格校准过滤（排除触碰 styleBoundaries.never 的选题）
- `processSearchResults(results, keyword, profile, count)` → 搜索结果 → 评分 → 过滤 → 排序
- `runFreeResearch(opts)` → 主入口，读取 creator-profile 后执行全流程

设计原则：模块不执行搜索本身，由调用方（skill/tool）提供 searchResults，保持纯函数可测试。

## 3. `src/modules/writing/title-hashtag.ts` — 多平台标题/Hashtag 生成

5 个平台的规则化标题和 hashtag 生成：

- 平台规则定义：小红书 / 抖音 / 公众号 / 视频号 / B站（各有标题长度限制、hashtag 上限、风格建议）
- `generateTitleVariants(baseTopic, platform)` → 5 种风格变体（hook / list / question / story / direct）
- `generateHashtags(topic, platform, tags)` → 4 类 hashtag（topic / trending / niche / 组合）
- `generateForPlatform(baseTopic, platform, opts)` → 单平台一键生成
- `generateForAllPlatforms(baseTopic, platforms, opts)` → 多平台批量生成

## 4. 注册变更

- `index.ts`：新增 `autocrew_review` tool 注册（import + registerTool）
- `mcp/server.ts`：新增 `autocrew_review` tool 注册（import + tools 数组）

---

# Session 5 建议任务

**主题：风格校准 skill + onboarding skill + CLI review 命令**

对应 PRD 章节：二（onboarding）+ 三（skill trigger）+ 十五（迁移计划）

## 需要做的事

1. **风格校准 skill** `skills/style-calibration/SKILL.md`
   - 从墨灵 AI 迁移 4 阶段校准流程
   - Phase 0: 品牌调研 → Phase 1: 样本采集 → Phase 2: A/B 对比 → Phase 3: 写作人格生成
   - 写入 `~/.autocrew/STYLE.md` + 更新 creator-profile.json

2. **onboarding skill 完善** `skills/onboarding/SKILL.md`
   - 检测 creator-profile.json 是否存在
   - 从宿主 MEMORY.md 读取已有信息
   - 补问缺失字段（industry / platforms / audience）
   - 完成后自动继续用户原始请求

3. **CLI review 命令** `index.ts`
   - `openclaw crew review <content-id>` → 调用 executeReview full_review
   - `openclaw crew fix <content-id>` → 调用 executeReview auto_fix

4. **research tool 重构** `src/tools/research.ts`
   - Free 版路径接入 free-engine.ts
   - 保留 browser-first 作为 Pro 路径

## 需要读取的文件

- `src/tools/review.ts`（已完成）
- `src/modules/research/free-engine.ts`（已完成）
- `src/modules/writing/title-hashtag.ts`（已完成）
- `skills/onboarding/SKILL.md`（现有版本）
- `src/tools/research.ts`（需要重构）
