---
name: research
description: |
  Content topic research and competitor analysis. Activate when user asks to find topics, research competitors, analyze trending content, or generate content ideas for Chinese social media (Xiaohongshu, Douyin, WeChat, Bilibili, etc.).
---

# Research

> Executor skill. Now **intel-first**: gathers intelligence from multiple sources, then extracts topics from accumulated intel.

## Research Strategy

AutoCrew research is now **intel-first, multi-source**:

1. **Pull intel** from all configured sources (web search, RSS, trends, competitors)
2. **Archive to local intel library** (`~/.autocrew/pipeline/intel/`)
3. **Extract topics** from accumulated intel with scoring and profile matching
4. **Save to topic pool** (`~/.autocrew/pipeline/topics/`)

Two research paths:
- **情报 → 选题** (default): Pull latest intel, then generate topics from insights
- **选题 → 情报** (reverse): User has a topic idea, system does deep research to enrich it

## Inputs

| Parameter | Source | Required | Description |
|-----------|--------|----------|-------------|
| topic_count | Message | No | Number of topics to generate (default: 3) |
| direction | Message | No | Specific topic direction or theme |
| keyword | Message | No | Specific keyword for focused research |
| topic | Message | No | Existing topic for reverse deep research |

## Steps

### Path A: 情报 → 选题 (Intel-First, Default)

1. **Onboarding check** — Read `creator-profile.json`. If missing or `industry` is empty, trigger onboarding first.

2. **Pull intel** — Call `autocrew_intel` tool to gather from all sources:
   ```json
   { "action": "pull" }
   ```
   This runs 4 collectors in parallel:
   - **Web Search**: multi-dimension queries (行业动态, 争议话题, 数据报告, 教程, 趋势)
   - **RSS**: configured feeds from `_sources/rss.yaml`
   - **Trends**: platform hot lists from `_sources/trends.yaml` (国内: 微博/抖音/知乎/B站; 国际: HN/Reddit/Twitter/ProductHunt etc.)
   - **Competitors**: browser-based monitoring from `_sources/accounts.yaml`

   All results are deduplicated and archived as Markdown files in `~/.autocrew/pipeline/intel/{domain}/`.

3. **Review intel** — Call `autocrew_intel` to list recent intel:
   ```json
   { "action": "list" }
   ```

4. **Generate topics** — Based on accumulated intel + creator profile, generate topic candidates. For each topic:
   - Title: ≤20 characters, specific angle
   - Score: heat (话题热度) + differentiation (差异化) + audience_fit (受众匹配)
   - Angles: 2-3 切入角度建议
   - Intel refs: which intel items informed this topic
   - Suggested platforms and formats

5. **Quality gate** — each topic must pass:
   - [ ] Has a specific, non-obvious angle (not "AI工具推荐" but "AI工具用了3个月，这5个我删了")
   - [ ] References concrete intel data points
   - [ ] Answers "why now" — what makes this timely
   - [ ] Doesn't violate style boundaries (never list)

6. **Save topics** — Save to pipeline topic pool. Topics are Markdown files with frontmatter scores.

7. **Output summary:**
   ```
   📥 灵感源采集完成（Web Search: X, RSS: X, 趋势: X, 竞品: X）
   💡 从灵感源中提炼了 {count} 个选题：

   1. {title_1} (综合分: 83)
      切入角度: {angle}
   2. {title_2} (综合分: 76)
      切入角度: {angle}

   选一个开始写？或继续调研其他方向。
   ```

### Path B: 选题 → 情报 (Reverse Deep Research)

When user already has a topic idea and wants deeper research:

1. Call `autocrew_intel` with targeted keywords from the topic
2. Use `web_search` for deep-dive queries specific to the topic angle
3. Save gathered intel to library
4. Enrich the existing topic file with new references and angles

```json
{ "action": "pull", "keywords": ["Cursor Agent", "Claude Code", "AI编程工具对比"] }
```

### Fallback Modes

If intel pull returns no results from configured sources:

1. **Browser-first fallback** — Use host-provided CDP capabilities to inspect platform content directly
2. **Free engine fallback** — Use `autocrew_research` tool's free mode with web search + viral scoring
3. **Manual fallback** — Generate topics from LLM knowledge, note that no live data was available

## Error Handling

| Failure | Action |
|---------|--------|
| No creator profile | Trigger onboarding |
| RSS/trends sources not configured | Guide through source setup, continue with web search |
| Browser session unavailable | Skip competitor collector, use other sources |
| All sources fail | Fall back to free engine, then LLM knowledge |
| Topic save fails | Log error, continue saving remaining topics |

## Changelog

- 2026-03-31: v1 — Initial version. Web search as primary data source.
- 2026-03-31: v2 — Browser-first research strategy.
- 2026-04-01: v3 — Added Free mode using free-engine.ts.
- 2026-04-03: v4 — **Intel-first rewrite.** Multi-source intel engine (web search + RSS + trends + competitors). Intel archived as Markdown. Topics extracted from accumulated intel with scoring. Two paths: intel→topics and topic→intel. Pipeline integration.
