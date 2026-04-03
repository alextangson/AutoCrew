---
name: intel-digest
description: |
  Summarize recent intel into a digestible briefing. Activate when user asks for intel summary, weekly digest, domain overview, or "本周洞察".
triggers:
  - "情报摘要"
  - "本周洞察"
  - "领域总结"
  - "intel digest"
invokable: true
---

# 情报摘要

> Executor skill. Reads accumulated intel and produces a structured briefing.

## Steps

1. **Load intel** — Call `autocrew_intel` tool:
   ```json
   { "action": "list" }
   ```
   Or filter by domain:
   ```json
   { "action": "list", "domain": "AI编程" }
   ```

2. **Analyze and summarize** — Group intel by domain, then for each domain:
   - Identify top 3 themes/trends
   - Highlight items with highest relevance scores
   - Note any competitive movements (source: competitor)
   - Flag time-sensitive items (expires soon)

3. **Output briefing** — Format as:
   ```
   📊 情报摘要 (最近 7 天)

   ## AI编程 (12 条情报)

   **核心趋势**
   1. Agent 模式成为各家 IDE 标配 — Cursor, Windsurf, Claude Code 均已支持
   2. 本地化部署需求上升 — Ollama 下载量创新高

   **竞品动态**
   - 花爷发布了 3 篇关于 Cursor 的内容，互动数据良好

   **推荐关注**
   - [Cursor Agent 发布](source_url) — 相关度 0.92
   - [Claude Code Hooks](source_url) — 相关度 0.85

   ---

   需要从这些洞察中提炼选题吗？
   ```

4. **Follow up** — Offer to generate topics from insights or do deeper research on specific themes.
