# Knowledge Wiki Design

## Overview

A persistent, compounding knowledge layer for AutoCrew. Sits between raw intel and content
creation, automatically synthesizing accumulated intelligence into structured wiki pages
that cross-reference each other and grow with every new source ingested.

Solves: knowledge doesn't compound — every content creation session starts from scratch,
re-searching and re-organizing the same territory.

## Architecture

### Storage Location

`~/.autocrew/data/pipeline/wiki/` — peer to intel/, topics/, drafting/ etc.
Created by `initPipeline()`.

### Directory Structure (flat)

```
pipeline/wiki/
├── index.md              # Global catalog, organized by type headings
├── log.md                # Append-only timeline of all sync/ingest/lint operations
├── cursor.md             # Flat layout — no subdirectories
├── vibe-coding.md
├── karpathy.md
└── cursor-vs-claude-code.md
```

No entity/concept/comparison subdirectories. Categories live in frontmatter `type` field
and index.md heading groups. Flat structure until 100+ pages warrants domain-based splitting.

### Page Format (unified)

```markdown
---
type: entity | concept | comparison
title: Cursor
aliases: [Cursor AI, Cursor Editor]
related: [vibe-coding, claude-code]
sources: [ai-tools/2026-04-05-cursor-agent-mode.md]
created: 2026-04-05
updated: 2026-04-06
---

# Cursor

{LLM-synthesized content — multi-paragraph, structured, with [[wikilinks]]}

## Key Facts
- Anysphere, valued at $2.6B in 2024
- VS Code fork with Claude/GPT integration

## Related
- [[vibe-coding]] — Cursor is a core vibe-coding tool
- [[cursor-vs-claude-code]] — Comparison with Claude Code
```

Key fields:
- `sources`: intel file paths for traceability
- `related`: cross-references maintained by knowledge-sync
- `aliases`: alternative names for search matching

### index.md Format

```markdown
# AutoCrew Knowledge Wiki

## Entities
- [Cursor](cursor.md) — AI code editor, core vibe-coding tool
- [Karpathy](karpathy.md) — AI educator, llm-wiki creator

## Concepts
- [Vibe Coding](vibe-coding.md) — Programming driven by natural language
- [Clock Theory](clock-theory.md) — Video content rhythm control framework

## Comparisons
- [Cursor vs Claude Code](cursor-vs-claude-code.md) — IDE-native vs terminal-native
```

One line per entry, under 80 chars. Regenerated on every sync.

### log.md Format

```markdown
## [2026-04-06] sync | 3 new intel items processed
- Updated: cursor.md (added Agent Mode facts)
- Created: vibe-coding.md (from 3 intel sources)
- Lint: 0 contradictions, 0 orphans

## [2026-04-06] ingest | manual URL
- Source: https://example.com/article
- Created: karpathy.md
```

Append-only. Enables timeline tracking and grep-based debugging.

## Components

### 1. knowledge-sync Skill

Orchestrator skill. Triggered automatically after intel pull/ingest, or manually
("sync knowledge base" / "整理知识库").

**Incremental sync flow:**

```
1. Read log.md → get last sync timestamp
2. Scan intel library → filter items newer than last sync
3. Scan all project references/ → filter new reference files
4. If nothing new → skip, return "wiki is up to date"
5. For each new item:
   a. Read index.md → check if related page exists
   b. If exists → read page, incrementally update (append facts, update numbers,
      add source). Do NOT rewrite the whole page.
   c. If not exists → create page ONLY if ≥2 related items exist (single items
      stay in intel library, not worth a wiki page yet)
   d. On create/update → scan other pages' related fields, add bidirectional
      cross-references
6. Regenerate index.md (grouped by type, one-line summaries)
7. Append to log.md: timestamp + pages created/updated + sources
8. Lint check (silent, findings go to log):
   - Contradiction: same fact has conflicting numbers/claims across pages
   - Orphan: page with no inbound references from other pages
   - Stale: sources[] contains intel past its expiresAfter date
```

**Constraints:**
- Incremental update != rewrite. Preserve existing content, only append/correct.
- ≥2 items threshold before creating a new page. Avoids wiki bloat.
- sources[] must be updated on every page touch.

### 2. autocrew_intel "ingest" Action

Extends the existing intel tool for user-initiated single-source ingestion.

**Schema addition:**

```json
{
  "action": "ingest",
  "url": "https://...",
  "text": "...",
  "domain": "ai-tools",
  "tags": ["vibe-coding", "cursor"]
}
```

Three input modes (mutually exclusive — one required):
- `url` — fetch and extract a web page
- `text` — directly ingest provided content
- `memory_paths` — harvest domain knowledge from local AI tool memory files

`domain` optional — LLM infers if not provided.
`tags` optional.

**Flow (URL / text mode):**

```
1. Acquire content:
   - URL mode → WebFetch to extract page content
   - Text mode → use directly
2. LLM extracts structured IntelItem:
   - title, summary, keyPoints, topicPotential
   - domain (user-specified or auto-inferred)
   - source: "manual"
   - relevance (LLM-assessed 1-100)
3. Call existing saveIntel() → writes to intel library
4. Auto-trigger knowledge-sync
5. Return: title, domain, wiki pages created/updated
```

**Flow (memory mode):**

```json
{
  "action": "ingest",
  "memory_paths": ["~/.claude/projects/-Users-jiaxintang-AutoCrew/memory/"],
  "domain": "auto"
}
```

```
1. Glob *.md files from each specified memory path
2. Read each file, classify content:
   - Domain knowledge / industry insight → extract as IntelItem
   - Preferences / config / session-specific → skip
   Filter criteria: does this file contain facts, judgments, or patterns
   about a DOMAIN (not about the tool or workflow)?
3. For each valuable file → generate IntelItem:
   - source: "memory"
   - title: derived from memory file name/content
   - domain: auto-inferred from content or user-specified
   - relevance: LLM-assessed 1-100
4. Deduplicate against existing intel library (title + domain match)
5. Call saveIntel() for each new item
6. Auto-trigger knowledge-sync
7. Return: {scanned: N, extracted: M, skipped: K, wiki pages updated: [...]}
```

**Privacy constraints for memory mode:**
- NEVER auto-scan. Only triggered by explicit user request ("把我的 memory 导入知识库")
- User specifies which project paths to scan — no wildcard all-projects sweep
- One-time harvest, not continuous sync. User re-runs when they want fresh extraction.
- Memory files containing credentials, tokens, or personal identifiers are always skipped.

### 3. write-script Step 5.5 Integration

Add wiki query as the FIRST step in Step 5.5, before intel library queries.

**New step a.0 (before existing a):**

```
a.0. Query wiki knowledge base:
   1. Read ~/.autocrew/data/pipeline/wiki/index.md
   2. Find wiki pages matching topic keywords
   3. Read matched pages (max 5, prioritize by relevance)
   4. Write wiki content as references into project references/ folder
      - Filename prefix: wiki-{slug}.md (e.g., wiki-cursor.md)
      - Auto-set relevance: 8 (synthesized knowledge > raw intel)
   5. Wiki-sourced references count toward the 6-reference minimum
      and can satisfy multiple angle-coverage categories
      (wiki pages are cross-source syntheses by nature)
```

**Why wiki before intel:**
- Wiki is already synthesized, cross-referenced, deduplicated
- May satisfy reference requirements immediately, saving intel pull costs
- Does NOT replace intel queries — new topics may have no wiki coverage yet

## Data Flow Diagram

```
User drops URL ──────→ autocrew_intel ingest ──→ saveIntel() ──→ intel library
User pastes text ────→ autocrew_intel ingest ──→ saveIntel() ──→ intel library
User says "导入memory" → autocrew_intel ingest ──→ saveIntel() ──→ intel library
                           (memory_paths mode)          │
autocrew_intel pull ──→ collectors ──→ saveIntel() ──→ intel library
                                                        │
                                    ┌───────────────────┘
                                    ▼
                             knowledge-sync
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              update pages    create pages    regenerate index.md
                    │               │               │
                    └───────┬───────┘               │
                            ▼                       ▼
                      pipeline/wiki/          log.md append
                            │
                            ▼
              write-script Step 5.5 a.0
                            │
                            ▼
                project references/wiki-*.md
                            │
                            ▼
                    content creation
```

## Implementation Scope

| Component | Type | Effort |
|-----------|------|--------|
| `initPipeline()` add wiki/ dir | Extend existing | Minimal |
| `autocrew_intel` ingest action | Extend existing tool | Small |
| knowledge-sync skill | New SKILL.md | Medium |
| write-script Step 5.5 a.0 | Extend existing skill | Small |
| Pipeline-store wiki helpers | New utility functions | Small |

No new tools, no new modules, no new databases.

## Date

2026-04-06
