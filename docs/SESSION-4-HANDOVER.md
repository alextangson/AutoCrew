# Session 3 完成内容

新增 5 个文件：

## 1. `src/data/sensitive-words-builtin.json` — 内置敏感词库

- 6 大分类：political / violence / adult / medical_claim / financial_claim / platform_restricted
- 3 个平台特定词库：xiaohongshu / douyin / wechat，每个含 restricted 列表 + suggestions 替换映射
- 版本化管理，随插件发布

## 2. `src/modules/filter/sensitive-words.ts` — 敏感词过滤模块

- `scanText(text, platform?, dataDir?)` → `ScanResult`
  - 扫描内置词库 + 用户自定义 `~/.autocrew/sensitive-words/custom.txt` + 平台特定限流词
  - 返回命中词列表（word / category / suggestion / positions）
  - 自动生成 `autoFixedText`（有替换建议的词自动替换）
  - 大小写不敏感匹配
- 内置缓存机制，词库只加载一次

## 3. `src/modules/learnings/diff-tracker.ts` — Diff 追踪模块

- `recordDiff(contentId, field, before, after)` → 记录编辑 diff 到 `~/.autocrew/learnings/edits/`
- `detectPatterns(before, after)` → 自动检测 8 种编辑模式：
  - `remove_progression_words` / `break_long_paragraphs` / `remove_ai_phrases`
  - `add_colloquial_tone` / `reduce_we_pronoun` / `shorten_content`
  - `add_emoji` / `casualize_tone`
- `getPatternFrequency()` → 统计所有 diff 中各模式出现频率
- `listDiffs()` → 查询历史 diff 记录

## 4. `src/modules/learnings/rule-distiller.ts` — 规则提炼模块

- `distillRules(dataDir?)` → `DistillResult`
  - 读取 diff-tracker 的模式频率
  - 达到阈值（5+ 次）的模式自动提炼为 `WritingRule`
  - 写入 `creator-profile.json` 的 `writingRules` 字段
  - 返回新规则 + 接近阈值的 emerging 模式
- `shouldDistill()` → 快速检查是否有待提炼的模式
- 8 种模式到规则的映射（PATTERN_TO_RULE）

## 5. `skills/content-review/SKILL.md` — 内容审核 Skill

5 步审核流程：
1. 敏感词扫描（内置 + 平台 + 自定义）
2. 平台合规检查（小红书/抖音/微信各有规则）
3. 去 AI 味检查（调用 humanizeZh dry-run）
4. 质量评分（信息密度 + Hook 强度 + CTA 清晰度 + 可读性，满分 100）
5. 输出审核报告 + 修复建议

状态机联动：
- 全部通过 → `reviewing → approved`
- 需要修改 → `reviewing → revision`（自动记录 diff_note）

Learnings 联动：
- 用户采纳修改 → diff-tracker 记录 → rule-distiller 检查阈值 → 自动提炼规则

---

# Session 4 建议任务

**主题：autocrew_review tool 实现 + 选题引擎 Free 版**

对应 PRD 章节：六（tool 层实现）+ 五（Free 版选题引擎）

## 需要做的事

1. **autocrew_review tool** `src/tools/review.ts`
   - 新增 `autocrew_review` tool，整合 sensitive-words + humanizer-zh + 质量评分
   - action: `full_review` / `scan_only` / `quality_score` / `auto_fix`
   - 注册到 `mcp/server.ts` 和 `index.ts`

2. **Free 版选题引擎** `src/modules/research/free-engine.ts`
   - 纯 web_search 选题（不依赖爬虫）
   - 风格校准过滤（读取 creator-profile 的 writingRules）
   - 爆款评分算法

3. **多平台标题/Hashtag 生成** `src/modules/writing/title-hashtag.ts`
   - 按平台规则生成标题变体
   - 按平台热度生成 hashtag 建议

## 需要读取的文件

- `src/modules/filter/sensitive-words.ts`（已完成）
- `src/modules/humanizer/zh.ts`（已完成）
- `src/modules/learnings/diff-tracker.ts`（已完成）
- `src/tools/content-save.ts`（参考 tool 注册模式）
- `skills/research/SKILL.md`（选题 skill 现有逻辑）
- `docs/PRD-v2.md` 章节五、六
