---
name: knowledge-sync
description: |
  Synchronize the knowledge wiki with new intel and references. Auto-triggered after
  intel pull/ingest, or manually via "同步知识库" / "整理 wiki" / "sync knowledge base".
---

# Knowledge Sync

> Executor skill. Reads new intel items and project references, synthesizes wiki pages,
> maintains cross-references, regenerates index, and runs lint checks.

## Prerequisites

Before syncing, verify:
- `~/.autocrew/data/pipeline/wiki/` exists (if not, it will be created by initPipeline)
- At least one intel item exists in the library

## Steps

1. **Determine what's new:**

   a. Read `~/.autocrew/data/pipeline/wiki/log.md` to find the last sync timestamp.
      If log.md doesn't exist, treat everything as new.

   b. Call `autocrew_intel` with `action: "list"` to get all intel items.
      Filter to items with `collectedAt` after the last sync timestamp.

   c. Glob all project `references/` folders:
      `~/.autocrew/data/pipeline/drafting/*/references/*.md`
      Filter to files modified after last sync timestamp.

   d. If nothing new → respond "知识库已是最新，无新素材需要消化。" and stop.

2. **Analyze and cluster new items:**

   For each new intel/reference item:
   - Extract key entities (company names, people, products, tools)
   - Extract key concepts (methodologies, patterns, trends)
   - Identify potential comparison pairs (X vs Y signals)

   Group items by entity/concept relevance.

3. **Update or create wiki pages:**

   Read `~/.autocrew/data/pipeline/wiki/index.md` to get existing pages.

   For each entity/concept cluster:

   a. **If a wiki page already exists** (match by slug or aliases):
      - Read the existing page
      - INCREMENTALLY update: append new facts to "Key Facts", add new source
        to frontmatter `sources[]`, update `updated` date
      - Do NOT rewrite the page. Preserve all existing content.
      - Add the new information in context with what already exists.

   b. **If no page exists AND ≥2 items reference this entity/concept:**
      - Create a new wiki page with the unified format:
        ```
        ---
        type: entity | concept | comparison
        title: {Title}
        aliases: [{alternative names}]
        related: [{related page slugs}]
        sources: [{intel file paths that inform this page}]
        created: {today}
        updated: {today}
        ---

        # {Title}

        {2-4 paragraphs synthesizing all source material}

        ## Key Facts
        - {concrete facts with sources}

        ## Related
        - [[{related-slug}]] — {one-line relationship description}
        ```

   c. **If no page exists AND only 1 item references this:** skip. Single-source
      entities stay in the intel library until more evidence accumulates.

4. **Update cross-references:**

   After all page creates/updates, scan all wiki pages:
   - For each page, check if its `related[]` field is complete
   - If page A mentions page B's title/aliases in its body but B is not in A's `related[]`, add it
   - Ensure bidirectional: if A relates to B, B should relate to A
   - Write updated pages back to disk

5. **Regenerate index.md:**

   Rebuild `~/.autocrew/data/pipeline/wiki/index.md` from all pages,
   grouped by type (Entities / Concepts / Comparisons), sorted alphabetically,
   one line per entry with title + first-sentence summary.

6. **Append to log.md:**

   ```
   ## [YYYY-MM-DD] sync | {N} new items processed
   - Created: {list of new pages}
   - Updated: {list of updated pages}
   - Skipped: {count of single-source items not worth a page yet}
   - Lint: {summary}
   ```

7. **Lint check (silent — findings go to log only):**

   - **Contradiction:** same fact has conflicting numbers/claims across pages
     → log: "⚠️ Contradiction: {page A} says X, {page B} says Y"
   - **Orphan:** page with zero inbound `related[]` references from other pages
     → log: "⚠️ Orphan: {page} has no inbound links"
   - **Stale:** page's `sources[]` contains intel files that have been archived (expired)
     → log: "⚠️ Stale: {page} references expired intel {source}"

8. **Report to user:**

   > 知识库同步完成：
   > - 新增页面：{list}
   > - 更新页面：{list}
   > - 当前 wiki 共 {N} 页
   > - Lint 问题：{count}（详见 log.md）

## Error Handling

| Failure | Action |
|---------|--------|
| No new items since last sync | Report "已是最新" and stop |
| Wiki directory missing | Call initPipeline to create it |
| Intel list returns empty | Report "情报库为空，请先运行情报采集" |
| Page write fails | Log error, continue with remaining pages |
| Lint finds contradictions | Log to log.md, do not auto-resolve (user decides) |

## Changelog

- 2026-04-06: v1 — Initial version. Incremental sync, cross-references, lint.
