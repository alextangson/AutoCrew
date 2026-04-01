---
name: research
description: |
  Content topic research and competitor analysis. Activate when user asks to find topics, research competitors, analyze trending content, or generate content ideas for Chinese social media (Xiaohongshu, Douyin, WeChat).
---

# Research

> Executor skill. Searches trending topics, analyzes competitor content, and saves topics locally.

## Research Mode

AutoCrew research is now **browser-first**:

1. Prefer the user's own logged-in browser session through the host runtime's CDP / browser tools.
2. Use API providers like TikHub only as fallback.
3. If neither is available, degrade to manual/web search based research.

Do not assume TikHub is the default data source anymore.

## Inputs

| Parameter | Source | Required | Description |
|-----------|--------|----------|-------------|
| topic_count | Message | No | Number of topics to generate (default: 3) |
| direction | Message | No | Specific topic direction or theme |
| user_requirements | Message | No | Additional constraints |

## Steps

1. Read `MEMORY.md` (if exists at `~/.autocrew/MEMORY.md`). Extract: industry, platforms, audience, content style, competitor accounts (`Competitor Accounts` section).
   - IF MEMORY.md is empty or industry is missing THEN ask user for their niche/industry before proceeding.

2. Check for XHS competitor accounts in MEMORY.md.
   - IF no XHS competitors THEN go to Step 3C (degraded mode).
   - IF XHS competitors exist THEN go to Step 3A (normal mode).

3A. **Normal mode / browser-first**

Use host-provided browser/CDP capabilities first:

- open the user's logged-in platform session
- inspect competitor recent notes/videos
- inspect platform hot lists
- inspect creator center or search result pages when relevant

Only if browser access is blocked should you drop to Step 3B.

3B. **Fallback mode / API provider**

If browser-first is unavailable, use TikHub or other structured providers when configured:

- fetch competitor recent posts
- fetch platform content detail when available
- keep a note that results came from fallback API mode

3C. **Free mode** — 纯公开搜索 + 爆款评分引擎:

   使用 `autocrew_research` tool 的 `free` mode：
   ```json
   {
     "action": "discover",
     "keyword": "AI 编程",
     "platform": "xiaohongshu",
     "mode": "free",
     "search_results": [/* 由 web_search 提供 */]
   }
   ```

   Free 引擎流程：
   1. 调用方先用 `web_search` 搜索 3-5 条查询（引擎会生成推荐查询）
   2. 将搜索结果传入 `search_results` 参数
   3. 引擎自动评分（标题吸引力 + 话题热度 + 用户匹配度）
   4. 风格校准过滤（排除触碰 styleBoundaries.never 的选题）
   5. 返回排序后的候选选题

   **推荐搜索查询模板**（由 free-engine 的 `buildSearchQueries` 生成）：
   - `{industry} {keyword} 内容选题`
   - `{industry} 热门话题 {当前月份}`
   - `{keyword} 爆款内容 分析`
   - `{keyword} {平台名} 爆款`
   - `{keyword} 最新趋势 {年份}`

3D. **Manual degraded mode** — 无任何数据源:

   Use `web_search` only:
   - Search: `{industry} 内容选题 小红书`
   - Search: `{industry} 热门话题 {current_month}`
   - Search: `{industry} 爆款内容 分析`

4. **Generate topics.** For each topic:
   - Title: ≤20 characters, specific angle (not generic)
   - Description: WHY this topic has potential + cite the data source
   - Tags: 3-5 relevant tags
   - Source: where the idea came from (competitor name, trend, hot list)

   Prefer using the `autocrew_research` tool in browser-first mode when available:
   ```json
   {
     "action": "discover",
     "keyword": "AI 编程",
     "platform": "xiaohongshu",
     "topic_count": 5
   }
   ```

5. **Quality gate** — before saving, each topic must pass:
   - [ ] Has a specific, non-obvious angle (not "AI工具推荐" but "AI工具用了3个月，这5个我删了")
   - [ ] Description cites a concrete data point or evidence
   - [ ] Answers "why now" — what makes this timely

6. **Save topics** using `autocrew_topic` tool:
   ```json
   { "action": "create", "title": "...", "description": "...", "tags": [...], "source": "..." }
   ```
   Save each topic individually. Count successes.

7. **Output summary:**
   ```
   调研完成，共保存 {saved_count} 个选题：
   1. {title_1}
   2. {title_2}
   ...
   下一步可以选一个开始写，或者让我继续调研其他方向。
   ```

## Error Handling

| Failure | Action |
|---------|--------|
| Browser session unavailable | Fall back to API provider mode, then degraded mode |
| TikHub unavailable | Continue with browser-first or degraded mode |
| All searches fail | Use general knowledge to generate topics. Note in description that no live data was available. |
| Topic save fails | Log error, continue saving remaining topics. |

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo research.md. Removed backend API dependency, uses autocrew_topic tool. TikHub optional, web_search as primary data source.
- 2026-03-31: v2 — Strategy shifted to browser-first research using user-managed login sessions. TikHub moved to fallback provider role.
- 2026-04-01: v3 — Added Free mode (Step 3C) using free-engine.ts. Auto mode now falls back to free engine before manual degradation. New `search_results` parameter for pre-fetched web search data.
