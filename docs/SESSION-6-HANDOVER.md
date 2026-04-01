# Session 5 完成内容

修改 6 个文件：

## 1. `skills/style-calibration/SKILL.md` — 4 阶段品牌校准

重构为完整 4 阶段流程：
- Phase 0: 品牌调研（定位/目标/受众/风格禁区）
- Phase 1: 样本采集与分析（风格特征提取，无样本时提供 3 种模板选择）
- Phase 2: A/B 对比验证（两个版本让用户选，微调风格参数）
- Phase 3: 写作人格生成（写入 STYLE.md + 更新 creator-profile.json，设 `styleCalibrated: true`）

## 2. `skills/onboarding/SKILL.md` — 首次引导完善

新增：
- Step 1: `autocrew_init` 初始化数据目录
- Step 2: MEMORY.md 多模式字段匹配（industry/platforms/audience/competitors/style）
- Step 6: 明确自动继续原始请求的实现方式
- 幂等原则：多次运行不丢数据

## 3. `index.ts` — CLI review/fix 命令

新增两个 CLI 子命令：
- `openclaw crew review <content-id>` → full_review，输出审核摘要 + 修复建议
- `openclaw crew fix <content-id>` → auto_fix，自动修复敏感词 + 去 AI 味并保存

同时更新了 `autocrew_research` tool 的 description。

## 4. `src/tools/research.ts` — Free 版路径接入

- 新增 `free` mode，走 `free-engine.ts` 的 web search + viral scoring 流程
- 新增 `search_results` 参数，调用方传入 web_search 结果
- auto 模式下 browser + API 都无结果时，自动 fallback 到 free engine
- 保留 browser_first 作为 Pro 路径不变

## 5. `mcp/server.ts` — description 更新

research tool description 更新为包含 free mode 说明。

## 6. `skills/research/SKILL.md` — Free mode 文档

新增 Step 3C Free mode 说明，包含推荐搜索查询模板和 free-engine 流程。

---

# Session 6 建议任务

**主题：write-script skill 重构 + 多平台改写 skill + 发布前检查清单**

1. **write-script skill 重构** `skills/write-script/SKILL.md`
   - 接入 STYLE.md 风格档案
   - 接入 title-hashtag.ts 自动生成标题和 hashtag
   - 写完自动触发 review（如果 styleCalibrated）

2. **platform-rewrite skill 完善** `skills/platform-rewrite/SKILL.md`
   - 多平台一键改写流程
   - 接入 title-hashtag.ts 的 `generateForAllPlatforms`

3. **发布前检查清单 skill** `skills/pre-publish/SKILL.md`
   - review 通过 + cover 审核通过 + hashtag 已生成 → 才允许发布
   - 输出 checklist 状态

## 需要读取的文件

- `skills/write-script/SKILL.md`（现有版本）
- `skills/platform-rewrite/SKILL.md`（现有版本）
- `src/modules/writing/title-hashtag.ts`（已完成）
- `src/tools/rewrite.ts`（已完成）
- `src/tools/publish.ts`（已完成）
