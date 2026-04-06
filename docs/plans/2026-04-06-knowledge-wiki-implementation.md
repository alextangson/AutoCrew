# Knowledge Wiki Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a persistent, compounding knowledge layer that auto-synthesizes intel into cross-referenced wiki pages and feeds them back into content creation.

**Architecture:** Flat wiki directory under `pipeline/wiki/` with markdown pages (frontmatter + body). `initPipeline()` creates the directory. `autocrew_intel` gets an `ingest` action for manual sourcing. A new `knowledge-sync` skill orchestrates incremental synthesis. `write-script` Step 5.5 queries wiki before intel.

**Tech Stack:** TypeScript, Vitest, gray-matter, js-yaml, existing pipeline-store patterns.

---

### Task 1: Add `wiki` to PIPELINE_STAGES and `initPipeline()`

**Files:**
- Modify: `src/storage/pipeline-store.ts:8-15` (PIPELINE_STAGES array)
- Modify: `src/storage/pipeline-store.ts:138-152` (initPipeline function)
- Test: `src/storage/pipeline-store.test.ts`

**Step 1: Write the failing test**

Add to the existing "Pipeline Initialization" describe block:

```typescript
it("creates wiki directory", async () => {
  await initPipeline(testDir);
  const wikiDir = path.join(pipelinePath(testDir), "wiki");
  const stat = await fs.stat(wikiDir);
  expect(stat.isDirectory()).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/pipeline-store.test.ts -t "creates wiki directory"`
Expected: FAIL — wiki directory does not exist.

**Step 3: Write minimal implementation**

In `src/storage/pipeline-store.ts`:

1. Add `"wiki"` to `PIPELINE_STAGES` array (line 8-15):
```typescript
export const PIPELINE_STAGES = [
  "intel",
  "topics",
  "drafting",
  "production",
  "published",
  "trash",
  "wiki",
] as const;
```

2. The existing `initPipeline()` loop `for (const stage of PIPELINE_STAGES)` will automatically create `wiki/`. No other changes needed — the loop handles it.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/pipeline-store.test.ts -t "creates wiki directory"`
Expected: PASS

**Step 5: Run full test suite to check for regressions**

Run: `npm test`
Expected: All 341+ tests pass. Watch for any test that iterates PIPELINE_STAGES and may break with the new entry.

**Step 6: Commit**

```bash
git add src/storage/pipeline-store.ts src/storage/pipeline-store.test.ts
git commit -m "feat: add wiki to pipeline stages"
```

---

### Task 2: Add wiki helper functions to pipeline-store

**Files:**
- Modify: `src/storage/pipeline-store.ts` (add new exports after intel section)
- Test: `src/storage/pipeline-store.test.ts`

**Step 1: Define WikiPage interface**

Add after the `IntelItem` interface (~line 39):

```typescript
export interface WikiPage {
  type: "entity" | "concept" | "comparison";
  title: string;
  aliases: string[];
  related: string[];
  sources: string[];
  created: string;
  updated: string;
  body: string;
}
```

**Step 2: Write failing tests for wiki helpers**

Add a new describe block:

```typescript
describe("Wiki Storage", () => {
  it("saves and reads a wiki page", async () => {
    await initPipeline(testDir);
    const page: WikiPage = {
      type: "entity",
      title: "Cursor",
      aliases: ["Cursor AI"],
      related: ["vibe-coding"],
      sources: ["ai-tools/2026-04-05-cursor.md"],
      created: "2026-04-05",
      updated: "2026-04-05",
      body: "# Cursor\n\nAI code editor by Anysphere.\n\n## Key Facts\n- VS Code fork",
    };

    const filePath = await saveWikiPage(page, testDir);
    expect(filePath).toContain("wiki/cursor.md");

    const loaded = await getWikiPage("cursor", testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Cursor");
    expect(loaded!.aliases).toContain("Cursor AI");
    expect(loaded!.sources).toHaveLength(1);
  });

  it("lists all wiki pages", async () => {
    await initPipeline(testDir);
    await saveWikiPage({
      type: "entity", title: "Cursor", aliases: [], related: [],
      sources: [], created: "2026-04-05", updated: "2026-04-05",
      body: "# Cursor\n\nEditor.",
    }, testDir);
    await saveWikiPage({
      type: "concept", title: "Vibe Coding", aliases: [], related: [],
      sources: [], created: "2026-04-05", updated: "2026-04-05",
      body: "# Vibe Coding\n\nNew paradigm.",
    }, testDir);

    const pages = await listWikiPages(testDir);
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.title).sort()).toEqual(["Cursor", "Vibe Coding"]);
  });

  it("generates index.md grouped by type", async () => {
    await initPipeline(testDir);
    await saveWikiPage({
      type: "entity", title: "Cursor", aliases: [], related: [],
      sources: [], created: "2026-04-05", updated: "2026-04-05",
      body: "# Cursor\n\nEditor.",
    }, testDir);
    await saveWikiPage({
      type: "concept", title: "Vibe Coding", aliases: [], related: [],
      sources: [], created: "2026-04-05", updated: "2026-04-05",
      body: "# Vibe Coding\n\nParadigm.",
    }, testDir);

    await regenerateWikiIndex(testDir);
    const indexContent = await fs.readFile(
      path.join(stagePath("wiki", testDir), "index.md"),
      "utf-8",
    );
    expect(indexContent).toContain("## Entities");
    expect(indexContent).toContain("## Concepts");
    expect(indexContent).toContain("[Cursor]");
    expect(indexContent).toContain("[Vibe Coding]");
  });

  it("appends to log.md", async () => {
    await initPipeline(testDir);
    await appendWikiLog("sync", "Created cursor.md from 2 intel sources", testDir);
    await appendWikiLog("ingest", "Manual URL: https://example.com", testDir);

    const logContent = await fs.readFile(
      path.join(stagePath("wiki", testDir), "log.md"),
      "utf-8",
    );
    expect(logContent).toContain("sync");
    expect(logContent).toContain("ingest");
    expect(logContent).toContain("cursor.md");
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `npx vitest run src/storage/pipeline-store.test.ts -t "Wiki Storage"`
Expected: FAIL — functions not defined.

**Step 4: Implement wiki helpers**

Add to `src/storage/pipeline-store.ts` after the intel storage section:

```typescript
// ─── Wiki Storage ──────────────────────────────────────────────────────────

export function wikiPageToMarkdown(page: WikiPage): string {
  const frontmatter: Record<string, unknown> = {
    type: page.type,
    title: page.title,
    aliases: page.aliases,
    related: page.related,
    sources: page.sources,
    created: page.created,
    updated: page.updated,
  };
  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd();
  return `---\n${yamlStr}\n---\n\n${page.body}\n`;
}

export function parseWikiPage(content: string): WikiPage {
  const { data, content: body } = matter(content);
  return {
    type: data.type ?? "entity",
    title: data.title ?? "",
    aliases: data.aliases ?? [],
    related: data.related ?? [],
    sources: data.sources ?? [],
    created: data.created ?? "",
    updated: data.updated ?? "",
    body: body.trim(),
  };
}

export async function saveWikiPage(
  page: WikiPage,
  dataDir?: string,
): Promise<string> {
  await initPipeline(dataDir);
  const wikiDir = stagePath("wiki", dataDir);
  const slug = slugify(page.title);
  const filePath = path.join(wikiDir, `${slug}.md`);
  await fs.writeFile(filePath, wikiPageToMarkdown(page), "utf-8");
  return filePath;
}

export async function getWikiPage(
  slug: string,
  dataDir?: string,
): Promise<WikiPage | null> {
  const filePath = path.join(stagePath("wiki", dataDir), `${slug}.md`);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseWikiPage(content);
  } catch {
    return null;
  }
}

export async function listWikiPages(
  dataDir?: string,
): Promise<WikiPage[]> {
  const wikiDir = stagePath("wiki", dataDir);
  const pages: WikiPage[] = [];
  try {
    const files = await fs.readdir(wikiDir);
    for (const file of files) {
      if (!file.endsWith(".md") || file === "index.md" || file === "log.md") continue;
      const content = await fs.readFile(path.join(wikiDir, file), "utf-8");
      pages.push(parseWikiPage(content));
    }
  } catch {
    // wiki dir may not exist yet
  }
  return pages;
}

export async function regenerateWikiIndex(dataDir?: string): Promise<void> {
  const pages = await listWikiPages(dataDir);
  const grouped: Record<string, WikiPage[]> = { entity: [], concept: [], comparison: [] };
  for (const page of pages) {
    (grouped[page.type] ??= []).push(page);
  }

  const lines = ["# AutoCrew Knowledge Wiki", ""];
  const headings: Record<string, string> = {
    entity: "Entities",
    concept: "Concepts",
    comparison: "Comparisons",
  };

  for (const [type, heading] of Object.entries(headings)) {
    const group = grouped[type] ?? [];
    if (group.length === 0) continue;
    lines.push(`## ${heading}`);
    for (const page of group.sort((a, b) => a.title.localeCompare(b.title))) {
      const slug = slugify(page.title);
      // Extract first sentence of body (skip heading line)
      const bodyLines = page.body.split("\n").filter((l) => !l.startsWith("#") && l.trim());
      const summary = bodyLines[0]?.slice(0, 60) ?? "";
      lines.push(`- [${page.title}](${slug}.md) — ${summary}`);
    }
    lines.push("");
  }

  await fs.writeFile(
    path.join(stagePath("wiki", dataDir), "index.md"),
    lines.join("\n"),
    "utf-8",
  );
}

export async function appendWikiLog(
  operation: string,
  description: string,
  dataDir?: string,
): Promise<void> {
  const logPath = path.join(stagePath("wiki", dataDir), "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `\n## [${date}] ${operation} | ${description}\n`;
  try {
    await fs.appendFile(logPath, entry, "utf-8");
  } catch {
    // File doesn't exist yet — create with entry
    await fs.writeFile(logPath, entry, "utf-8");
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/storage/pipeline-store.test.ts -t "Wiki Storage"`
Expected: PASS (all 4 tests)

**Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/storage/pipeline-store.ts src/storage/pipeline-store.test.ts
git commit -m "feat: add wiki page storage helpers"
```

---

### Task 3: Add `ingest` action to `autocrew_intel`

**Files:**
- Modify: `src/tools/intel.ts:6-16` (schema — add ingest action + new params)
- Modify: `src/tools/intel.ts:18-92` (executeIntel — add ingest case)
- Modify: `src/storage/pipeline-store.ts` (add `findIntelBySlug` for dedup)
- Test: `src/tools/intel.test.ts` (create if not exists, or add to existing)

**Step 1: Write failing test**

Create or extend `src/tools/intel.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeIntel } from "./intel.js";
import { listIntel, initPipeline } from "../storage/pipeline-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-intel-test-"));
  // Create minimal creator profile
  await fs.mkdir(path.join(testDir, "data"), { recursive: true });
  await fs.writeFile(
    path.join(testDir, "creator-profile.json"),
    JSON.stringify({ industry: "tech", platforms: ["xiaohongshu"], writingRules: [], styleCalibrated: false }),
    "utf-8",
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("intel ingest action", () => {
  it("ingests text and saves as intel item", async () => {
    await initPipeline(testDir);
    const result = await executeIntel({
      action: "ingest",
      text: "Cursor is an AI code editor by Anysphere. It reached $2.6B valuation in 2024. Built as a VS Code fork with integrated AI assistance.",
      domain: "ai-tools",
      tags: ["cursor", "ai-editor"],
      _dataDir: testDir,
    }) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.action).toBe("ingest");
    expect(result.saved).toBe(true);

    // Verify intel was saved
    const items = await listIntel("ai-tools", testDir);
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects ingest without url or text", async () => {
    const result = await executeIntel({
      action: "ingest",
      domain: "test",
      _dataDir: testDir,
    }) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("url, text, or memory_paths");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/intel.test.ts`
Expected: FAIL — "ingest" action not recognized.

**Step 3: Update schema**

In `src/tools/intel.ts`, update the schema:

```typescript
export const intelSchema = Type.Object({
  action: Type.Unsafe<string>({
    type: "string",
    enum: ["pull", "list", "clean", "ingest"],
    description:
      "Action: pull (collect intel), list (show saved), clean (archive expired), " +
      "ingest (manually add a single source via url/text/memory_paths).",
  }),
  domain: Type.Optional(Type.String({ description: "Filter by domain (list) or target domain (ingest)" })),
  source: Type.Optional(Type.String({ description: "Filter to specific source(s), comma-separated" })),
  keywords: Type.Optional(Type.Array(Type.String(), { description: "Override keywords for pull" })),
  // ingest-specific params
  url: Type.Optional(Type.String({ description: "URL to fetch and ingest (ingest action)" })),
  text: Type.Optional(Type.String({ description: "Raw text content to ingest (ingest action)" })),
  memory_paths: Type.Optional(Type.Array(Type.String(), { description: "Local memory file paths to harvest (ingest action)" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for ingested intel" })),
  _dataDir: Type.Optional(Type.String()),
});
```

**Step 4: Implement ingest case**

Add to the switch statement in `executeIntel()`:

```typescript
case "ingest": {
  const url = params.url as string | undefined;
  const text = params.text as string | undefined;
  const memoryPaths = params.memory_paths as string[] | undefined;

  if (!url && !text && !memoryPaths) {
    return { ok: false, error: "ingest requires url, text, or memory_paths" };
  }

  const tags = (params.tags as string[]) ?? [];
  const targetDomain = domain ?? "general";
  const now = new Date().toISOString();

  if (text) {
    // Text mode: directly create intel item
    // The LLM calling this tool should have already extracted title/summary.
    // We save the raw text as a generic intel item — the LLM will refine
    // during knowledge-sync.
    const title = text.slice(0, 60).replace(/\n/g, " ").trim();
    const item: IntelItem = {
      title,
      domain: targetDomain,
      source: "manual",
      collectedAt: now,
      relevance: 70,
      tags,
      expiresAfter: 365,
      summary: text.slice(0, 500),
      keyPoints: [],
      topicPotential: "",
    };
    const filePath = await saveIntel(item, dataDir);
    return { ok: true, action: "ingest", mode: "text", saved: true, filePath };
  }

  if (url) {
    // URL mode: save a placeholder — the LLM should use WebFetch first,
    // then call ingest with the extracted text.
    // For now, save the URL as a minimal intel item.
    const item: IntelItem = {
      title: `Ingested from ${new URL(url).hostname}`,
      domain: targetDomain,
      source: "manual",
      sourceUrl: url,
      collectedAt: now,
      relevance: 70,
      tags,
      expiresAfter: 365,
      summary: `Source URL: ${url}`,
      keyPoints: [],
      topicPotential: "",
    };
    const filePath = await saveIntel(item, dataDir);
    return { ok: true, action: "ingest", mode: "url", saved: true, filePath };
  }

  if (memoryPaths) {
    // Memory mode: scan specified paths for .md files
    let scanned = 0;
    let extracted = 0;
    let skipped = 0;
    const savedPaths: string[] = [];

    for (const memPath of memoryPaths) {
      const expandedPath = memPath.replace("~", process.env.HOME ?? ".");
      let files: string[];
      try {
        files = await import("node:fs/promises").then((f) => f.readdir(expandedPath));
      } catch {
        continue; // Path doesn't exist
      }

      for (const file of files) {
        if (!file.endsWith(".md") || file === "MEMORY.md") continue;
        scanned++;

        const content = await import("node:fs/promises").then((f) =>
          f.readFile(path.join(expandedPath, file), "utf-8"),
        );

        // Skip very short files or pure config files
        if (content.length < 100) { skipped++; continue; }

        // Save as intel item with source: "memory"
        const title = file.replace(".md", "").replace(/[-_]/g, " ");
        const item: IntelItem = {
          title,
          domain: targetDomain === "auto" ? "general" : targetDomain,
          source: "manual",
          collectedAt: now,
          relevance: 50,
          tags: [...tags, "memory-harvest"],
          expiresAfter: 730,
          summary: content.slice(0, 500),
          keyPoints: [],
          topicPotential: "",
        };

        const filePath = await saveIntel(item, dataDir);
        savedPaths.push(filePath);
        extracted++;
      }
    }

    return {
      ok: true,
      action: "ingest",
      mode: "memory",
      scanned,
      extracted,
      skipped,
      savedPaths,
    };
  }

  return { ok: false, error: "Unexpected ingest state" };
}
```

Note: import `saveIntel` and `IntelItem` type at top of file:
```typescript
import { saveIntel, type IntelItem } from "../storage/pipeline-store.js";
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/tools/intel.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 7: Update tool description in registry**

In `src/tools/registry.ts:148`, update the description:

```typescript
description:
  "Inspiration source pipeline. Actions: pull (collect from web/RSS/trends), " +
  "list (show saved), clean (archive expired), ingest (manually add url/text/memory).",
```

**Step 8: Commit**

```bash
git add src/tools/intel.ts src/tools/intel.test.ts src/tools/registry.ts src/storage/pipeline-store.ts
git commit -m "feat: add ingest action to autocrew_intel tool"
```

---

### Task 4: Create knowledge-sync skill

**Files:**
- Create: `skills/knowledge-sync/SKILL.md`

**Step 1: Write the skill**

```markdown
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
```

**Step 2: Verify skill file is valid**

Run: `head -5 skills/knowledge-sync/SKILL.md` — should show valid YAML frontmatter.

**Step 3: Commit**

```bash
git add skills/knowledge-sync/SKILL.md
git commit -m "feat: add knowledge-sync skill for wiki auto-synthesis"
```

---

### Task 5: Update write-script Step 5.5 to query wiki first

**Files:**
- Modify: `skills/write-script/SKILL.md` (Step 5.5, add a.0 before existing a)

**Step 1: Read current Step 5.5**

Read `skills/write-script/SKILL.md` and locate the Step 5.5 section (starts with
"⚠️ MANDATORY — Topic-specific research → populate `references/`").

**Step 2: Add wiki query as Step a.0**

Insert before the existing step `a. Compute the project slug early`:

```markdown
   a.0. **Query wiki knowledge base (if wiki exists):**
      1. Check if `~/.autocrew/data/pipeline/wiki/index.md` exists. If not, skip to step a.
      2. Read `index.md` and find wiki pages whose title, aliases, or summary
         match the current topic's keywords or angle (fuzzy match, not exact).
      3. Read matched pages (max 5, prioritize by number of sources — more sources
         = more synthesized = more valuable).
      4. For each matched wiki page, write it as a reference file into the project's
         `references/` folder:
         - Filename: `wiki-{page-slug}.md`
         - Format: same as other reference files, but with `source: wiki/{page-slug}.md`
         - Set `relevance: 8` (synthesized knowledge is higher value than raw intel)
      5. Wiki-sourced references count toward the 6-reference minimum and can satisfy
         multiple angle-coverage categories (wiki pages are cross-source syntheses).
      6. If wiki already provides 4+ solid references, the subsequent intel queries
         (steps b-d) can be lighter — focus on filling angle gaps rather than full research.
```

**Step 3: Verify skill file renders correctly**

Read back the modified section to ensure markdown is well-formed and step numbering is consistent.

**Step 4: Commit**

```bash
git add skills/write-script/SKILL.md
git commit -m "feat: write-script queries wiki before intel in Step 5.5"
```

---

### Task 6: Wire intel ingest/pull to auto-trigger knowledge-sync hint

**Files:**
- Modify: `src/tools/intel.ts` (add sync hint to pull and ingest return values)

**Step 1: Add `_triggerSync` flag to return values**

In the `pull` case return (line ~50):
```typescript
return {
  ok: true,
  action: "pull",
  totalCollected: result.totalCollected,
  totalSaved: result.totalSaved,
  bySource: result.bySource,
  errors: result.errors.length > 0 ? result.errors.slice(0, 10) : undefined,
  _triggerSync: result.totalSaved > 0,
  _syncHint: result.totalSaved > 0
    ? "新增情报已入库。请运行 knowledge-sync 同步知识库。"
    : undefined,
};
```

In each ingest mode return, add:
```typescript
  _triggerSync: true,
  _syncHint: "新素材已入库。请运行 knowledge-sync 同步知识库。",
```

Note: The `_triggerSync` flag is a hint for the LLM orchestration layer — the skill
description in `knowledge-sync` says it auto-triggers after pull/ingest, and this hint
reinforces that. There is no actual auto-execution; the LLM reads the hint and invokes
knowledge-sync as instructed by the skill.

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass (return value changes are additive).

**Step 3: Commit**

```bash
git add src/tools/intel.ts
git commit -m "feat: intel pull/ingest returns sync hint for knowledge-sync"
```

---

### Task 7: Integration test — full ingest → sync → query cycle

**Files:**
- Create: `src/modules/wiki/wiki.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  initPipeline,
  saveIntel,
  saveWikiPage,
  getWikiPage,
  listWikiPages,
  regenerateWikiIndex,
  appendWikiLog,
  stagePath,
  slugify,
  type IntelItem,
  type WikiPage,
} from "../../storage/pipeline-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-wiki-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("Wiki Integration", () => {
  it("full lifecycle: save intel → create wiki page → regenerate index → log", async () => {
    await initPipeline(testDir);

    // 1. Save two related intel items about the same entity
    const intel1: IntelItem = {
      title: "Cursor reaches 2.6B valuation",
      domain: "ai-tools",
      source: "web_search",
      collectedAt: new Date().toISOString(),
      relevance: 85,
      tags: ["cursor", "funding"],
      expiresAfter: 90,
      summary: "Anysphere's Cursor editor valued at $2.6B",
      keyPoints: ["VS Code fork", "$2.6B valuation", "AI-first editor"],
      topicPotential: "AI tool funding trends",
    };
    const intel2: IntelItem = {
      title: "Cursor Agent Mode launches",
      domain: "ai-tools",
      source: "web_search",
      collectedAt: new Date().toISOString(),
      relevance: 80,
      tags: ["cursor", "agent"],
      expiresAfter: 90,
      summary: "Cursor launches agent mode for autonomous coding",
      keyPoints: ["Agent mode", "Autonomous coding", "Background tasks"],
      topicPotential: "AI coding evolution",
    };
    await saveIntel(intel1, testDir);
    await saveIntel(intel2, testDir);

    // 2. Create a wiki page synthesizing both
    const page: WikiPage = {
      type: "entity",
      title: "Cursor",
      aliases: ["Cursor AI", "Cursor Editor"],
      related: [],
      sources: [
        `ai-tools/${new Date().toISOString().slice(0, 10)}-cursor-reaches-2-6b-valuation.md`,
        `ai-tools/${new Date().toISOString().slice(0, 10)}-cursor-agent-mode-launches.md`,
      ],
      created: new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString().slice(0, 10),
      body: "# Cursor\n\nAI code editor by Anysphere.\n\n## Key Facts\n- VS Code fork with integrated AI\n- $2.6B valuation (2024)\n- Agent Mode for autonomous coding",
    };
    await saveWikiPage(page, testDir);

    // 3. Verify page saved correctly
    const loaded = await getWikiPage("cursor", testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Cursor");
    expect(loaded!.sources).toHaveLength(2);

    // 4. Regenerate index
    await regenerateWikiIndex(testDir);
    const indexContent = await fs.readFile(
      path.join(stagePath("wiki", testDir), "index.md"),
      "utf-8",
    );
    expect(indexContent).toContain("[Cursor]");
    expect(indexContent).toContain("## Entities");

    // 5. Log the sync
    await appendWikiLog("sync", "Created cursor.md from 2 intel sources", testDir);
    const logContent = await fs.readFile(
      path.join(stagePath("wiki", testDir), "log.md"),
      "utf-8",
    );
    expect(logContent).toContain("sync");
    expect(logContent).toContain("cursor.md");

    // 6. Verify flat structure — no subdirectories
    const wikiFiles = await fs.readdir(stagePath("wiki", testDir));
    expect(wikiFiles).toContain("cursor.md");
    expect(wikiFiles).toContain("index.md");
    expect(wikiFiles).toContain("log.md");
    // No entity/ or concept/ subdirectories
    for (const f of wikiFiles) {
      const stat = await fs.stat(path.join(stagePath("wiki", testDir), f));
      expect(stat.isFile()).toBe(true);
    }
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run src/modules/wiki/wiki.test.ts`
Expected: PASS

**Step 3: Run full suite**

Run: `npm test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/modules/wiki/wiki.test.ts
git commit -m "test: add wiki integration test for full lifecycle"
```

---

## Summary

| Task | Description | Files | Commits |
|------|-------------|-------|---------|
| 1 | Add `wiki` to PIPELINE_STAGES | pipeline-store.ts, test | 1 |
| 2 | Wiki storage helpers (save/get/list/index/log) | pipeline-store.ts, test | 1 |
| 3 | `ingest` action for autocrew_intel | intel.ts, intel.test.ts, registry.ts | 1 |
| 4 | knowledge-sync skill SKILL.md | skills/knowledge-sync/SKILL.md | 1 |
| 5 | write-script Step 5.5 wiki query | skills/write-script/SKILL.md | 1 |
| 6 | Sync hint flag on pull/ingest returns | intel.ts | 1 |
| 7 | Integration test | src/modules/wiki/wiki.test.ts | 1 |

Total: 7 tasks, 7 commits, ~400 lines of new code + 1 new skill.
