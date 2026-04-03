---
name: intel-pull
description: |
  Pull latest intel from all configured sources (RSS, web search, trends, competitors). Activate when user asks for latest news, updates, intel refresh, or "有什么新消息".
triggers:
  - "最新资讯"
  - "拉取情报"
  - "有什么新消息"
  - "更新情报"
  - "intel pull"
invokable: true
---

# 情报拉取

> Executor skill. Fetches latest intel from all configured sources and archives to local intel library.

## Steps

1. **Onboarding check** — Read `creator-profile.json`. If missing or `industry` is empty, trigger onboarding first.

2. **Pull intel** — Call `autocrew_intel` tool:
   ```json
   { "action": "pull" }
   ```
   Optionally filter by source:
   ```json
   { "action": "pull", "source": "rss" }
   ```

   The tool runs all configured collectors in parallel:
   - Web Search: multi-dimension queries (行业动态, 争议话题, 数据报告, 教程)
   - RSS: configured feeds from `~/.autocrew/pipeline/intel/_sources/rss.yaml`
   - Trends: platform hot lists from `trends.yaml` (微博热搜, Hacker News, etc.)
   - Competitors: browser-based monitoring from `accounts.yaml`

3. **Display results** — Format as:
   ```
   📥 情报更新完成
   - Web Search: X 条
   - RSS: X 条
   - 热榜趋势: X 条
   - 竞品监控: X 条

   **{领域1}** (N 条新增)
   1. {title_1}
   2. {title_2}

   **{领域2}** (N 条新增)
   1. {title_1}
   ```

4. **Follow up** — Ask:
   ```
   需要从这些情报中提炼选题吗？
   ```
   If yes, call `autocrew_intel` with `action: "list"` to get full intel, then use LLM to generate TopicCandidates and save via `autocrew_topic`.

## First-Time Setup

If `_sources/` configs are empty, guide user through source setup:
1. Based on `creator-profile.json` industry, recommend sources via `getRecommendedSources()`
2. Let user confirm/modify
3. Write to `_sources/rss.yaml`, `_sources/trends.yaml` etc.

## Error Handling

| Failure | Action |
|---------|--------|
| No creator profile | Trigger onboarding |
| RSS fetch fails | Log error, continue with other sources |
| Browser unavailable | Skip competitor collector, note in output |
| All sources fail | Report failure, suggest checking source configs |
