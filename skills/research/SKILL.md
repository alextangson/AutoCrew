---
name: research
description: |
  Content topic research and competitor analysis. Activate when user asks to find topics, research competitors, analyze trending content, or generate content ideas for Chinese social media (Xiaohongshu, Douyin, WeChat).
---

# Research

> Executor skill. Searches trending topics, analyzes competitor content, and saves topics locally.

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
   - IF no XHS competitors THEN go to Step 3B (degraded mode).
   - IF XHS competitors exist THEN go to Step 3A (normal mode).

3A. **Normal mode** — gather data from 3 sources:

   **Source 1: Competitor recent notes (TikHub)**
   For each XHS competitor, use `web_search` or TikHub API (if token configured):
   - Find their recent popular posts (last 7 days)
   - Extract: title, engagement metrics, content type
   - Take top 3-5 by engagement

   **Source 2: Trending topics**
   Use `web_search` to find current trending topics in the user's industry:
   - Search: `{industry} 热门话题 小红书 2026`
   - Search: `{industry} 最新趋势`
   - Extract top 3-5 relevant trends

   **Source 3: Platform hot lists**
   Use `web_search` to check platform-specific trending:
   - `小红书 热门笔记 {industry}`
   - `抖音 热门视频 {industry}`

3B. **Degraded mode** — no competitor data:
   Use `web_search` only:
   - Search: `{industry} 内容选题 小红书`
   - Search: `{industry} 热门话题 {current_month}`
   - Search: `{industry} 爆款内容 分析`

4. **Generate topics.** For each topic:
   - Title: ≤20 characters, specific angle (not generic)
   - Description: WHY this topic has potential + cite the data source
   - Tags: 3-5 relevant tags
   - Source: where the idea came from (competitor name, trend, hot list)

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
| TikHub unavailable | Fall back to web_search only (degraded mode) |
| All searches fail | Use general knowledge to generate topics. Note in description that no live data was available. |
| Topic save fails | Log error, continue saving remaining topics. |

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo research.md. Removed backend API dependency, uses autocrew_topic tool. TikHub optional, web_search as primary data source.
