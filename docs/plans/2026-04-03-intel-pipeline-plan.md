# Intel Engine + Content Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace AutoCrew's single-source topic discovery with a multi-source intel engine, Markdown-based topic pool, and file-system-driven content pipeline with stage transitions and version tracking.

**Architecture:** New `pipeline/` directory under `~/.autocrew/` with 6 stages (intel → topics → drafting → production → ready → published + trash). Intel engine uses a collector interface pattern with 4 implementations (web search, RSS, competitor monitoring, platform trends). Storage layer refactored from JSON to Markdown+frontmatter. Pipeline transitions move project folders between stage directories.

**Tech Stack:** TypeScript (ESM), Vitest, `@sinclair/typebox` for schemas, `rss-parser` for RSS feeds, `js-yaml` for YAML config, `gray-matter` for Markdown frontmatter parsing, existing `browser-cdp` adapter for competitor/trend scraping.

**Design Doc:** `docs/plans/2026-04-03-intel-pipeline-design.md`

---

## Task 1: Add Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install new dependencies**

```bash
cd /Users/jiaxintang/AutoCrew
npm install rss-parser js-yaml gray-matter
npm install -D @types/js-yaml
```

These provide:
- `rss-parser` — Parse RSS/Atom feeds
- `js-yaml` — Parse YAML config files (`_sources/*.yaml`)
- `gray-matter` — Parse/stringify Markdown frontmatter (intel + topic files)

**Step 2: Verify install**

Run: `npm test`
Expected: All existing tests still pass.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add rss-parser, js-yaml, gray-matter dependencies"
```

---

## Task 2: Pipeline Storage Layer — Types & Directory Init

**Files:**
- Create: `src/storage/pipeline-store.ts`
- Create: `src/storage/pipeline-store.test.ts`

This task creates the foundation: TypeScript types for the pipeline and directory initialization logic.

**Step 1: Write the failing test**

```typescript
// src/storage/pipeline-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initPipeline, PIPELINE_STAGES, type PipelineStage } from "./pipeline-store.js";

describe("pipeline-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("initPipeline", () => {
    it("creates all pipeline stage directories", () => {
      initPipeline(tmpDir);

      for (const stage of PIPELINE_STAGES) {
        const dir = path.join(tmpDir, "pipeline", stage);
        expect(fs.existsSync(dir)).toBe(true);
      }
    });

    it("creates intel subdirectories", () => {
      initPipeline(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, "pipeline", "intel", "_sources"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "pipeline", "intel", "_archive"))).toBe(true);
    });

    it("is idempotent", () => {
      initPipeline(tmpDir);
      initPipeline(tmpDir);

      for (const stage of PIPELINE_STAGES) {
        expect(fs.existsSync(path.join(tmpDir, "pipeline", stage))).toBe(true);
      }
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/pipeline-store.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

```typescript
// src/storage/pipeline-store.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import matter from "gray-matter";
import yaml from "js-yaml";

// --- Types ---

export const PIPELINE_STAGES = [
  "intel",
  "topics",
  "drafting",
  "production",
  "published",
  "trash",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface IntelItem {
  title: string;
  domain: string;
  source: "web_search" | "rss" | "competitor" | "trend" | "manual";
  sourceUrl?: string;
  collectedAt: string;
  relevance: number;
  tags: string[];
  expiresAfter: string; // e.g. "30d"
  summary: string;
  keyPoints: string[];
  topicPotential: string[];
}

export interface TopicCandidate {
  title: string;
  domain: string;
  score: {
    heat: number;
    differentiation: number;
    audienceFit: number;
    overall: number;
  };
  formats: string[];
  suggestedPlatforms: string[];
  createdAt: string;
  intelRefs: string[];
  angles: string[];
  audienceResonance: string[];
  references: string[];
}

export interface DraftVersion {
  file: string;
  createdAt: string;
  note: string;
}

export interface PlatformStatus {
  format: string;
  status: string;
}

export interface StageEntry {
  stage: string;
  entered: string;
}

export interface ProjectMeta {
  title: string;
  domain: string;
  format: string;
  createdAt: string;
  sourceTopic: string;
  intelRefs: string[];
  versions: DraftVersion[];
  current: string;
  history: StageEntry[];
  platforms: Record<string, PlatformStatus>;
}

// --- Paths ---

function defaultDataDir(): string {
  return path.join(os.homedir(), ".autocrew");
}

export function pipelinePath(dataDir?: string): string {
  return path.join(dataDir ?? defaultDataDir(), "pipeline");
}

export function stagePath(stage: PipelineStage, dataDir?: string): string {
  return path.join(pipelinePath(dataDir), stage);
}

// --- Init ---

export function initPipeline(dataDir?: string): void {
  const base = pipelinePath(dataDir);

  for (const stage of PIPELINE_STAGES) {
    fs.mkdirSync(path.join(base, stage), { recursive: true });
  }

  // Intel subdirectories
  fs.mkdirSync(path.join(base, "intel", "_sources"), { recursive: true });
  fs.mkdirSync(path.join(base, "intel", "_archive"), { recursive: true });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/pipeline-store.test.ts`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add src/storage/pipeline-store.ts src/storage/pipeline-store.test.ts
git commit -m "feat: add pipeline storage types and directory initialization"
```

---

## Task 3: Intel Storage — Save, List, Archive

**Files:**
- Modify: `src/storage/pipeline-store.ts`
- Modify: `src/storage/pipeline-store.test.ts`

Add functions to save intel items as Markdown, list them by domain, and archive expired items.

**Step 1: Write the failing tests**

Append to `src/storage/pipeline-store.test.ts`:

```typescript
import {
  initPipeline,
  PIPELINE_STAGES,
  saveIntel,
  listIntel,
  archiveExpiredIntel,
  type IntelItem,
} from "./pipeline-store.js";

describe("intel storage", () => {
  it("saves intel as markdown with frontmatter", () => {
    initPipeline(tmpDir);

    const item: IntelItem = {
      title: "Cursor 发布 Agent 模式",
      domain: "AI编程",
      source: "rss",
      sourceUrl: "https://example.com/post",
      collectedAt: "2026-04-03T10:30:00+08:00",
      relevance: 0.85,
      tags: ["Cursor", "AI编程"],
      expiresAfter: "30d",
      summary: "Cursor 正式发布 Agent 模式",
      keyPoints: ["支持多文件编辑", "内置终端"],
      topicPotential: ["深度体验对比"],
    };

    const filePath = saveIntel(item, tmpDir);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain("AI编程");
    expect(filePath).toContain("cursor-发布-agent-模式");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("title: Cursor 发布 Agent 模式");
    expect(content).toContain("domain: AI编程");
    expect(content).toContain("## 摘要");
  });

  it("lists intel by domain", () => {
    initPipeline(tmpDir);

    saveIntel({ title: "A", domain: "AI编程", source: "rss", collectedAt: "2026-04-01T00:00:00Z", relevance: 0.8, tags: [], expiresAfter: "30d", summary: "a", keyPoints: [], topicPotential: [] }, tmpDir);
    saveIntel({ title: "B", domain: "美妆", source: "rss", collectedAt: "2026-04-01T00:00:00Z", relevance: 0.8, tags: [], expiresAfter: "30d", summary: "b", keyPoints: [], topicPotential: [] }, tmpDir);

    const all = listIntel(undefined, tmpDir);
    expect(all.length).toBe(2);

    const ai = listIntel("AI编程", tmpDir);
    expect(ai.length).toBe(1);
    expect(ai[0].title).toBe("A");
  });

  it("deduplicates by title similarity", () => {
    initPipeline(tmpDir);

    saveIntel({ title: "Cursor 发布 Agent 模式", domain: "AI编程", source: "rss", collectedAt: "2026-04-01T00:00:00Z", relevance: 0.8, tags: [], expiresAfter: "30d", summary: "a", keyPoints: [], topicPotential: [] }, tmpDir);
    const second = saveIntel({ title: "Cursor 发布 Agent 模式", domain: "AI编程", source: "web_search", collectedAt: "2026-04-02T00:00:00Z", relevance: 0.9, tags: [], expiresAfter: "30d", summary: "b", keyPoints: [], topicPotential: [] }, tmpDir);

    // Should not create a second file
    const items = listIntel("AI编程", tmpDir);
    expect(items.length).toBe(1);
  });

  it("archives expired intel", () => {
    initPipeline(tmpDir);

    saveIntel({ title: "Old news", domain: "AI编程", source: "rss", collectedAt: "2025-01-01T00:00:00Z", relevance: 0.5, tags: [], expiresAfter: "1d", summary: "old", keyPoints: [], topicPotential: [] }, tmpDir);

    const archived = archiveExpiredIntel(tmpDir);
    expect(archived).toBe(1);

    const remaining = listIntel("AI编程", tmpDir);
    expect(remaining.length).toBe(0);

    // Check archive directory has the file
    const archiveDir = path.join(tmpDir, "pipeline", "intel", "_archive");
    const files = fs.readdirSync(archiveDir);
    expect(files.length).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/pipeline-store.test.ts`
Expected: FAIL — `saveIntel` is not exported.

**Step 3: Implement intel storage functions**

Add to `src/storage/pipeline-store.ts`:

```typescript
// --- Intel ---

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function datePrefix(isoDate: string): string {
  return isoDate.slice(0, 10); // YYYY-MM-DD
}

function parseExpiry(expiresAfter: string, from: string): Date {
  const match = expiresAfter.match(/^(\d+)d$/);
  const days = match ? parseInt(match[1], 10) : 30;
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

function intelToMarkdown(item: IntelItem): string {
  const frontmatter: Record<string, unknown> = {
    title: item.title,
    domain: item.domain,
    source: item.source,
    collected_at: item.collectedAt,
    relevance: item.relevance,
    tags: item.tags,
    expires_after: item.expiresAfter,
  };
  if (item.sourceUrl) frontmatter.source_url = item.sourceUrl;

  let body = `## 摘要\n\n${item.summary}\n`;
  if (item.keyPoints.length) {
    body += `\n## 关键信息\n\n${item.keyPoints.map((p) => `- ${p}`).join("\n")}\n`;
  }
  if (item.topicPotential.length) {
    body += `\n## 选题潜力\n\n${item.topicPotential.map((p) => `- ${p}`).join("\n")}\n`;
  }

  return matter.stringify(body, frontmatter);
}

function parseIntelFile(filePath: string): IntelItem | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    return {
      title: data.title ?? "",
      domain: data.domain ?? "",
      source: data.source ?? "manual",
      sourceUrl: data.source_url,
      collectedAt: data.collected_at ?? "",
      relevance: data.relevance ?? 0,
      tags: data.tags ?? [],
      expiresAfter: data.expires_after ?? "30d",
      summary: content.trim(),
      keyPoints: [],
      topicPotential: [],
    };
  } catch {
    return null;
  }
}

function findDuplicateIntel(title: string, domain: string, dataDir?: string): string | null {
  const domainDir = path.join(stagePath("intel", dataDir), domain);
  if (!fs.existsSync(domainDir)) return null;

  const slug = slugify(title);
  const files = fs.readdirSync(domainDir).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    if (slugify(f).includes(slug)) {
      return path.join(domainDir, f);
    }
  }
  return null;
}

export function saveIntel(item: IntelItem, dataDir?: string): string {
  const domainDir = path.join(stagePath("intel", dataDir), item.domain);
  fs.mkdirSync(domainDir, { recursive: true });

  // Dedup check
  const existing = findDuplicateIntel(item.title, item.domain, dataDir);
  if (existing) return existing;

  const filename = `${datePrefix(item.collectedAt)}-${slugify(item.title)}.md`;
  const filePath = path.join(domainDir, filename);
  fs.writeFileSync(filePath, intelToMarkdown(item), "utf-8");
  return filePath;
}

export function listIntel(domain?: string, dataDir?: string): IntelItem[] {
  const intelDir = stagePath("intel", dataDir);
  const results: IntelItem[] = [];

  const domains = domain
    ? [domain]
    : fs.readdirSync(intelDir).filter((d) => !d.startsWith("_") && fs.statSync(path.join(intelDir, d)).isDirectory());

  for (const d of domains) {
    const domainDir = path.join(intelDir, d);
    if (!fs.existsSync(domainDir)) continue;

    const files = fs.readdirSync(domainDir).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const item = parseIntelFile(path.join(domainDir, f));
      if (item) results.push(item);
    }
  }

  return results.sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
}

export function archiveExpiredIntel(dataDir?: string): number {
  const intelDir = stagePath("intel", dataDir);
  const archiveDir = path.join(intelDir, "_archive");
  fs.mkdirSync(archiveDir, { recursive: true });

  const now = new Date();
  let count = 0;

  const domains = fs.readdirSync(intelDir).filter(
    (d) => !d.startsWith("_") && fs.statSync(path.join(intelDir, d)).isDirectory()
  );

  for (const d of domains) {
    const domainDir = path.join(intelDir, d);
    const files = fs.readdirSync(domainDir).filter((f) => f.endsWith(".md"));

    for (const f of files) {
      const filePath = path.join(domainDir, f);
      const item = parseIntelFile(filePath);
      if (!item) continue;

      const expiry = parseExpiry(item.expiresAfter, item.collectedAt);
      if (expiry < now) {
        fs.renameSync(filePath, path.join(archiveDir, f));
        count++;
      }
    }
  }

  return count;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/pipeline-store.test.ts`
Expected: PASS (all tests).

**Step 5: Commit**

```bash
git add src/storage/pipeline-store.ts src/storage/pipeline-store.test.ts
git commit -m "feat: add intel storage — save, list, dedup, archive expired"
```

---

## Task 4: Topic Pool Storage — Save, List, Score Decay

**Files:**
- Modify: `src/storage/pipeline-store.ts`
- Modify: `src/storage/pipeline-store.test.ts`

**Step 1: Write the failing tests**

Append to test file:

```typescript
import {
  saveTopic as savePipelineTopic,
  listTopics as listPipelineTopics,
  decayTopicScores,
  type TopicCandidate,
} from "./pipeline-store.js";

describe("topic pool storage", () => {
  it("saves topic as markdown with frontmatter scores", () => {
    initPipeline(tmpDir);

    const topic: TopicCandidate = {
      title: "Cursor vs Claude Code 对比",
      domain: "AI编程",
      score: { heat: 82, differentiation: 75, audienceFit: 90, overall: 83 },
      formats: ["image-text", "video"],
      suggestedPlatforms: ["xiaohongshu", "bilibili"],
      createdAt: "2026-04-03",
      intelRefs: ["intel/AI编程/2026-04-03-cursor-agent.md"],
      angles: ["实操对比", "适用场景分析"],
      audienceResonance: ["选工具的决策焦虑"],
      references: [],
    };

    const filePath = savePipelineTopic(topic, tmpDir);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("overall: 83");
    expect(content).toContain("## 切入角度");
  });

  it("lists topics sorted by overall score desc", () => {
    initPipeline(tmpDir);

    savePipelineTopic({ title: "Low", domain: "AI编程", score: { heat: 20, differentiation: 20, audienceFit: 20, overall: 20 }, formats: [], suggestedPlatforms: [], createdAt: "2026-04-03", intelRefs: [], angles: [], audienceResonance: [], references: [] }, tmpDir);
    savePipelineTopic({ title: "High", domain: "AI编程", score: { heat: 90, differentiation: 90, audienceFit: 90, overall: 90 }, formats: [], suggestedPlatforms: [], createdAt: "2026-04-03", intelRefs: [], angles: [], audienceResonance: [], references: [] }, tmpDir);

    const topics = listPipelineTopics(undefined, tmpDir);
    expect(topics[0].title).toBe("High");
    expect(topics[1].title).toBe("Low");
  });

  it("decays scores for old topics and trashes low-score ones", () => {
    initPipeline(tmpDir);

    // 20 days old topic with score 30 — should decay below threshold and be trashed
    savePipelineTopic({ title: "Stale topic", domain: "AI编程", score: { heat: 30, differentiation: 30, audienceFit: 30, overall: 30 }, formats: [], suggestedPlatforms: [], createdAt: "2026-03-10", intelRefs: [], angles: [], audienceResonance: [], references: [] }, tmpDir);

    const { decayed, trashed } = decayTopicScores(tmpDir);
    expect(decayed).toBeGreaterThanOrEqual(1);
    expect(trashed).toBeGreaterThanOrEqual(1);

    const remaining = listPipelineTopics(undefined, tmpDir);
    expect(remaining.length).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/pipeline-store.test.ts`
Expected: FAIL — `saveTopic` not exported from pipeline-store.

**Step 3: Implement topic pool functions**

Add to `src/storage/pipeline-store.ts`:

```typescript
// --- Topics ---

function topicToMarkdown(topic: TopicCandidate): string {
  const frontmatter: Record<string, unknown> = {
    title: topic.title,
    domain: topic.domain,
    score: topic.score,
    formats: topic.formats,
    suggested_platforms: topic.suggestedPlatforms,
    created_at: topic.createdAt,
    intel_refs: topic.intelRefs,
  };

  let body = "";
  if (topic.angles.length) {
    body += `## 切入角度\n\n${topic.angles.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\n`;
  }
  if (topic.audienceResonance.length) {
    body += `## 目标受众共鸣点\n\n${topic.audienceResonance.map((r) => `- ${r}`).join("\n")}\n\n`;
  }
  if (topic.references.length) {
    body += `## 参考素材\n\n${topic.references.map((r) => `- ${r}`).join("\n")}\n`;
  }

  return matter.stringify(body, frontmatter);
}

function parseTopicFile(filePath: string): TopicCandidate | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data } = matter(raw);
    return {
      title: data.title ?? "",
      domain: data.domain ?? "",
      score: data.score ?? { heat: 0, differentiation: 0, audienceFit: 0, overall: 0 },
      formats: data.formats ?? [],
      suggestedPlatforms: data.suggested_platforms ?? [],
      createdAt: data.created_at ?? "",
      intelRefs: data.intel_refs ?? [],
      angles: [],
      audienceResonance: [],
      references: [],
    };
  } catch {
    return null;
  }
}

export function saveTopic(topic: TopicCandidate, dataDir?: string): string {
  const topicsDir = stagePath("topics", dataDir);
  fs.mkdirSync(topicsDir, { recursive: true });

  const filename = `${slugify(topic.domain)}-${slugify(topic.title)}.md`;
  const filePath = path.join(topicsDir, filename);
  fs.writeFileSync(filePath, topicToMarkdown(topic), "utf-8");
  return filePath;
}

export function listTopics(domain?: string, dataDir?: string): TopicCandidate[] {
  const topicsDir = stagePath("topics", dataDir);
  if (!fs.existsSync(topicsDir)) return [];

  const files = fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md"));
  const topics: TopicCandidate[] = [];

  for (const f of files) {
    const topic = parseTopicFile(path.join(topicsDir, f));
    if (!topic) continue;
    if (domain && topic.domain !== domain) continue;
    topics.push(topic);
  }

  return topics.sort((a, b) => b.score.overall - a.score.overall);
}

const DECAY_THRESHOLD_DAYS = 14;
const DECAY_RATE_PER_DAY = 2; // points per day after threshold
const TRASH_THRESHOLD = 20;

export function decayTopicScores(dataDir?: string): { decayed: number; trashed: number } {
  const topicsDir = stagePath("topics", dataDir);
  const trashDir = stagePath("trash", dataDir);
  if (!fs.existsSync(topicsDir)) return { decayed: 0, trashed: 0 };

  fs.mkdirSync(trashDir, { recursive: true });
  const now = new Date();
  let decayed = 0;
  let trashed = 0;

  const files = fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md"));

  for (const f of files) {
    const filePath = path.join(topicsDir, f);
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);

    const createdAt = new Date(data.created_at ?? "");
    const ageDays = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

    if (ageDays <= DECAY_THRESHOLD_DAYS) continue;

    const overdueDays = ageDays - DECAY_THRESHOLD_DAYS;
    const penalty = overdueDays * DECAY_RATE_PER_DAY;
    const score = data.score ?? { heat: 0, differentiation: 0, audienceFit: 0, overall: 0 };
    score.overall = Math.max(0, score.overall - penalty);
    data.score = score;
    decayed++;

    if (score.overall < TRASH_THRESHOLD) {
      fs.renameSync(filePath, path.join(trashDir, f));
      trashed++;
    } else {
      fs.writeFileSync(filePath, matter.stringify(content, data), "utf-8");
    }
  }

  return { decayed, trashed };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/pipeline-store.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/storage/pipeline-store.ts src/storage/pipeline-store.test.ts
git commit -m "feat: add topic pool storage — save, list, score decay"
```

---

## Task 5: Project Lifecycle — Start, Advance, Version, Trash/Restore

**Files:**
- Modify: `src/storage/pipeline-store.ts`
- Modify: `src/storage/pipeline-store.test.ts`

**Step 1: Write the failing tests**

Append to test file:

```typescript
import {
  startProject,
  advanceProject,
  addDraftVersion,
  trashProject,
  restoreProject,
  getProjectMeta,
  listProjects,
} from "./pipeline-store.js";

describe("project lifecycle", () => {
  it("starts a project from a topic", () => {
    initPipeline(tmpDir);
    const topicPath = savePipelineTopic({
      title: "Cursor 对比",
      domain: "AI编程",
      score: { heat: 80, differentiation: 70, audienceFit: 85, overall: 78 },
      formats: ["image-text"],
      suggestedPlatforms: ["xiaohongshu"],
      createdAt: "2026-04-03",
      intelRefs: ["intel/AI编程/2026-04-03-cursor.md"],
      angles: ["实操对比"],
      audienceResonance: [],
      references: [],
    }, tmpDir);

    const projectDir = startProject("AI编程-cursor-对比", tmpDir);
    expect(fs.existsSync(path.join(projectDir, "meta.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "draft-v1.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "draft.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "references"))).toBe(true);

    // Topic file should be removed from topics/
    expect(fs.existsSync(topicPath)).toBe(false);
  });

  it("advances a project from drafting to production", () => {
    initPipeline(tmpDir);
    savePipelineTopic({ title: "Test", domain: "AI编程", score: { heat: 80, differentiation: 70, audienceFit: 85, overall: 78 }, formats: [], suggestedPlatforms: [], createdAt: "2026-04-03", intelRefs: [], angles: [], audienceResonance: [], references: [] }, tmpDir);
    const projectDir = startProject("AI编程-test", tmpDir);

    const newDir = advanceProject("AI编程-test", tmpDir);
    expect(newDir).toContain("production");
    expect(fs.existsSync(newDir)).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(false);

    const meta = getProjectMeta("AI编程-test", tmpDir);
    expect(meta!.history.length).toBe(3); // topics → drafting → production
  });

  it("adds a new draft version", () => {
    initPipeline(tmpDir);
    savePipelineTopic({ title: "V", domain: "AI编程", score: { heat: 80, differentiation: 70, audienceFit: 85, overall: 78 }, formats: [], suggestedPlatforms: [], createdAt: "2026-04-03", intelRefs: [], angles: [], audienceResonance: [], references: [] }, tmpDir);
    startProject("AI编程-v", tmpDir);

    addDraftVersion("AI编程-v", "改进版内容", "用户反馈：开头太平", tmpDir);

    const meta = getProjectMeta("AI编程-v", tmpDir);
    expect(meta!.versions.length).toBe(2);
    expect(meta!.current).toBe("draft-v2.md");
  });

  it("trashes and restores a project", () => {
    initPipeline(tmpDir);
    savePipelineTopic({ title: "TR", domain: "AI编程", score: { heat: 80, differentiation: 70, audienceFit: 85, overall: 78 }, formats: [], suggestedPlatforms: [], createdAt: "2026-04-03", intelRefs: [], angles: [], audienceResonance: [], references: [] }, tmpDir);
    startProject("AI编程-tr", tmpDir);

    trashProject("AI编程-tr", tmpDir);
    expect(listProjects("drafting", tmpDir).length).toBe(0);

    restoreProject("AI编程-tr", tmpDir);
    expect(listProjects("drafting", tmpDir).length).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/storage/pipeline-store.test.ts`
Expected: FAIL — functions not exported.

**Step 3: Implement project lifecycle functions**

Add to `src/storage/pipeline-store.ts`:

```typescript
// --- Projects ---

const STAGE_ORDER: PipelineStage[] = ["topics", "drafting", "production", "published"];

function findProject(name: string, dataDir?: string): { stage: PipelineStage; dir: string } | null {
  for (const stage of PIPELINE_STAGES) {
    const dir = path.join(stagePath(stage, dataDir), name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return { stage, dir };
    }
  }
  return null;
}

function readMeta(projectDir: string): ProjectMeta | null {
  const metaPath = path.join(projectDir, "meta.yaml");
  if (!fs.existsSync(metaPath)) return null;
  return yaml.load(fs.readFileSync(metaPath, "utf-8")) as ProjectMeta;
}

function writeMeta(projectDir: string, meta: ProjectMeta): void {
  fs.writeFileSync(path.join(projectDir, "meta.yaml"), yaml.dump(meta, { lineWidth: -1 }), "utf-8");
}

export function startProject(topicSlug: string, dataDir?: string): string {
  const topicsDir = stagePath("topics", dataDir);
  const draftingDir = stagePath("drafting", dataDir);
  const now = new Date().toISOString();

  // Find and read topic file
  const topicFiles = fs.existsSync(topicsDir)
    ? fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md") && slugify(f).includes(slugify(topicSlug)))
    : [];
  const topicFile = topicFiles[0];
  let topicData: Record<string, unknown> = {};
  if (topicFile) {
    const raw = fs.readFileSync(path.join(topicsDir, topicFile), "utf-8");
    topicData = matter(raw).data;
  }

  // Create project directory
  const projectDir = path.join(draftingDir, topicSlug);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, "references"), { recursive: true });

  // Create initial draft
  const draftContent = `# ${topicData.title ?? topicSlug}\n\n<!-- 在此开始创作 -->\n`;
  fs.writeFileSync(path.join(projectDir, "draft-v1.md"), draftContent, "utf-8");
  fs.writeFileSync(path.join(projectDir, "draft.md"), draftContent, "utf-8");

  // Create meta.yaml
  const meta: ProjectMeta = {
    title: (topicData.title as string) ?? topicSlug,
    domain: (topicData.domain as string) ?? "",
    format: ((topicData.formats as string[]) ?? [])[0] ?? "text",
    createdAt: now,
    sourceTopic: topicFile ? `topics/${topicFile}` : "",
    intelRefs: (topicData.intel_refs as string[]) ?? [],
    versions: [{ file: "draft-v1.md", createdAt: now, note: "系统初稿" }],
    current: "draft-v1.md",
    history: [
      { stage: "topics", entered: (topicData.created_at as string) ?? now },
      { stage: "drafting", entered: now },
    ],
    platforms: {},
  };
  writeMeta(projectDir, meta);

  // Remove topic file
  if (topicFile) {
    fs.unlinkSync(path.join(topicsDir, topicFile));
  }

  return projectDir;
}

export function advanceProject(name: string, dataDir?: string): string {
  const found = findProject(name, dataDir);
  if (!found) throw new Error(`Project not found: ${name}`);

  const currentIdx = STAGE_ORDER.indexOf(found.stage);
  if (currentIdx === -1 || currentIdx >= STAGE_ORDER.length - 1) {
    throw new Error(`Cannot advance from stage: ${found.stage}`);
  }

  const nextStage = STAGE_ORDER[currentIdx + 1];
  const nextDir = path.join(stagePath(nextStage, dataDir), name);

  // Move directory
  fs.renameSync(found.dir, nextDir);

  // Update meta
  const meta = readMeta(nextDir);
  if (meta) {
    meta.history.push({ stage: nextStage, entered: new Date().toISOString() });
    writeMeta(nextDir, meta);
  }

  return nextDir;
}

export function addDraftVersion(name: string, content: string, note: string, dataDir?: string): string {
  const found = findProject(name, dataDir);
  if (!found) throw new Error(`Project not found: ${name}`);

  const meta = readMeta(found.dir);
  if (!meta) throw new Error(`No meta.yaml in project: ${name}`);

  const versionNum = meta.versions.length + 1;
  const filename = `draft-v${versionNum}.md`;
  const filePath = path.join(found.dir, filename);

  fs.writeFileSync(filePath, content, "utf-8");
  fs.writeFileSync(path.join(found.dir, "draft.md"), content, "utf-8");

  meta.versions.push({ file: filename, createdAt: new Date().toISOString(), note });
  meta.current = filename;
  writeMeta(found.dir, meta);

  return filePath;
}

export function trashProject(name: string, dataDir?: string): void {
  const found = findProject(name, dataDir);
  if (!found) throw new Error(`Project not found: ${name}`);

  const trashDir = path.join(stagePath("trash", dataDir), name);
  fs.renameSync(found.dir, trashDir);

  // Record previous stage in meta for restore
  const meta = readMeta(trashDir);
  if (meta) {
    meta.history.push({ stage: "trash", entered: new Date().toISOString() });
    writeMeta(trashDir, meta);
  }
}

export function restoreProject(name: string, dataDir?: string): void {
  const trashDir = path.join(stagePath("trash", dataDir), name);
  if (!fs.existsSync(trashDir)) throw new Error(`Not in trash: ${name}`);

  const meta = readMeta(trashDir);
  // Find the stage before trash
  const prevStage = meta?.history
    .filter((h) => h.stage !== "trash")
    .at(-1)?.stage as PipelineStage ?? "drafting";

  const restoreDir = path.join(stagePath(prevStage, dataDir), name);
  fs.renameSync(trashDir, restoreDir);

  if (meta) {
    meta.history.push({ stage: prevStage, entered: new Date().toISOString() });
    writeMeta(restoreDir, meta);
  }
}

export function getProjectMeta(name: string, dataDir?: string): ProjectMeta | null {
  const found = findProject(name, dataDir);
  if (!found) return null;
  return readMeta(found.dir);
}

export function listProjects(stage: PipelineStage, dataDir?: string): string[] {
  const dir = stagePath(stage, dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory());
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/storage/pipeline-store.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/storage/pipeline-store.ts src/storage/pipeline-store.test.ts
git commit -m "feat: add project lifecycle — start, advance, version, trash/restore"
```

---

## Task 6: Source Config Loader

**Files:**
- Create: `src/modules/intel/source-config.ts`
- Create: `src/modules/intel/source-config.test.ts`
- Create: `src/data/source-presets.yaml`

Loads `_sources/*.yaml` configs and provides industry-based source recommendations.

**Step 1: Write the failing test**

```typescript
// src/modules/intel/source-config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSourceConfig, getRecommendedSources } from "./source-config.js";

describe("source-config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-test-"));
    const sourcesDir = path.join(tmpDir, "pipeline", "intel", "_sources");
    fs.mkdirSync(sourcesDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads RSS config from _sources/rss.yaml", () => {
    const sourcesDir = path.join(tmpDir, "pipeline", "intel", "_sources");
    fs.writeFileSync(path.join(sourcesDir, "rss.yaml"), `feeds:\n  - url: https://sspai.com/feed\n    domain: 效率工具\n    tags: [生产力]\n`, "utf-8");

    const config = loadSourceConfig(tmpDir);
    expect(config.rss.feeds.length).toBe(1);
    expect(config.rss.feeds[0].url).toBe("https://sspai.com/feed");
  });

  it("returns empty arrays when config files don't exist", () => {
    const config = loadSourceConfig(tmpDir);
    expect(config.rss.feeds).toEqual([]);
    expect(config.trends.sources).toEqual([]);
    expect(config.accounts.accounts).toEqual([]);
  });

  it("recommends sources based on industry", () => {
    const sources = getRecommendedSources("科技");
    expect(sources.trends.some((s) => s.source === "hackernews")).toBe(true);
    expect(sources.trends.some((s) => s.source === "producthunt")).toBe(true);
  });

  it("recommends different sources for different industries", () => {
    const tech = getRecommendedSources("科技");
    const beauty = getRecommendedSources("美妆");
    expect(tech.trends).not.toEqual(beauty.trends);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/intel/source-config.test.ts`
Expected: FAIL.

**Step 3: Create source presets data file**

```yaml
# src/data/source-presets.yaml
presets:
  科技:
    trends:
      - { source: hackernews, min_score: 100 }
      - { source: producthunt }
      - { source: github_trending }
      - { source: twitter_trending, region: US }
      - { source: google_trends }
      - { source: zhihu_hot }
    rss_suggestions:
      - { url: "https://36kr.com/feed", domain: 科技 }
      - { url: "https://sspai.com/feed", domain: 效率工具 }

  AI:
    trends:
      - { source: hackernews, min_score: 100 }
      - { source: producthunt }
      - { source: github_trending }
      - { source: arxiv, categories: ["cs.AI", "cs.CL"] }
      - { source: reddit, subreddits: [ChatGPT, LocalLLaMA, MachineLearning] }
      - { source: twitter_trending, region: US }
    rss_suggestions: []

  美妆:
    trends:
      - { source: douyin_hot }
      - { source: weibo_hot }
      - { source: google_trends }
    rss_suggestions: []

  职场:
    trends:
      - { source: zhihu_hot }
      - { source: weibo_hot }
      - { source: twitter_trending }
      - { source: google_trends }
    rss_suggestions:
      - { url: "https://36kr.com/feed", domain: 商业 }

  教育:
    trends:
      - { source: zhihu_hot }
      - { source: bilibili_hot }
      - { source: google_trends }
    rss_suggestions: []

  美食:
    trends:
      - { source: douyin_hot }
      - { source: weibo_hot }
      - { source: google_trends }
    rss_suggestions: []

  _default:
    trends:
      - { source: weibo_hot }
      - { source: douyin_hot }
      - { source: google_trends }
      - { source: twitter_trending }
    rss_suggestions: []
```

**Step 4: Implement source-config module**

```typescript
// src/modules/intel/source-config.ts
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { pipelinePath } from "../../storage/pipeline-store.js";

export interface RssFeed {
  url: string;
  domain: string;
  tags?: string[];
}

export interface TrendSource {
  source: string;
  enabled?: boolean;
  region?: string;
  subreddits?: string[];
  min_score?: number;
  keywords?: string[];
  categories?: string[];
}

export interface CompetitorAccount {
  platform: string;
  name: string;
  id: string;
  domain: string;
}

export interface SourceConfig {
  rss: { feeds: RssFeed[] };
  trends: { sources: TrendSource[] };
  accounts: { accounts: CompetitorAccount[] };
  keywords: { keywords: string[]; filterMode: string };
}

export interface RecommendedSources {
  trends: TrendSource[];
  rssSuggestions: RssFeed[];
}

function loadYaml<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return yaml.load(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function loadSourceConfig(dataDir?: string): SourceConfig {
  const sourcesDir = path.join(pipelinePath(dataDir), "intel", "_sources");

  return {
    rss: loadYaml(path.join(sourcesDir, "rss.yaml"), { feeds: [] }),
    trends: loadYaml(path.join(sourcesDir, "trends.yaml"), { sources: [] }),
    accounts: loadYaml(path.join(sourcesDir, "accounts.yaml"), { accounts: [] }),
    keywords: loadYaml(path.join(sourcesDir, "keywords.yaml"), { keywords: [], filterMode: "any" }),
  };
}

let presetsCache: Record<string, { trends: TrendSource[]; rss_suggestions: RssFeed[] }> | null = null;

function loadPresets(): Record<string, { trends: TrendSource[]; rss_suggestions: RssFeed[] }> {
  if (presetsCache) return presetsCache;
  const presetsPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../../data/source-presets.yaml");
  const raw = yaml.load(fs.readFileSync(presetsPath, "utf-8")) as { presets: Record<string, unknown> };
  presetsCache = raw.presets as typeof presetsCache;
  return presetsCache!;
}

export function getRecommendedSources(industry: string): RecommendedSources {
  const presets = loadPresets();

  // Try exact match, then partial match, then default
  const key = Object.keys(presets).find(
    (k) => k !== "_default" && (k === industry || industry.includes(k) || k.includes(industry))
  ) ?? "_default";

  const preset = presets[key] ?? presets._default;
  return {
    trends: preset.trends ?? [],
    rssSuggestions: preset.rss_suggestions ?? [],
  };
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/modules/intel/source-config.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/modules/intel/ src/data/source-presets.yaml
git commit -m "feat: add source config loader with industry-based presets"
```

---

## Task 7: Collector Interface + Web Search Collector

**Files:**
- Create: `src/modules/intel/collector.ts` — interface
- Create: `src/modules/intel/collectors/web-search.ts`
- Create: `src/modules/intel/collectors/web-search.test.ts`

**Step 1: Write the failing test**

```typescript
// src/modules/intel/collectors/web-search.test.ts
import { describe, it, expect } from "vitest";
import { buildMultiDimensionQueries } from "./web-search.js";

describe("web-search collector", () => {
  it("generates multi-dimension search queries", () => {
    const queries = buildMultiDimensionQueries("Cursor", "AI编程", ["xiaohongshu"]);
    expect(queries.length).toBeGreaterThanOrEqual(4);
    expect(queries.some((q) => q.includes("最新"))).toBe(true);
    expect(queries.some((q) => q.includes("争议"))).toBe(true);
    expect(queries.some((q) => q.includes("教程"))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/intel/collectors/web-search.test.ts`
Expected: FAIL.

**Step 3: Create collector interface and web search collector**

```typescript
// src/modules/intel/collector.ts
import type { IntelItem } from "../../storage/pipeline-store.js";

export interface CollectorResult {
  items: IntelItem[];
  source: string;
  errors: string[];
}

export interface Collector {
  id: string;
  collect(opts: CollectorOptions): Promise<CollectorResult>;
}

export interface CollectorOptions {
  keywords: string[];
  industry: string;
  platforms: string[];
  dataDir?: string;
}
```

```typescript
// src/modules/intel/collectors/web-search.ts
import type { Collector, CollectorOptions, CollectorResult } from "../collector.js";
import type { IntelItem } from "../../../storage/pipeline-store.js";

const now = () => new Date().toISOString();
const currentYear = () => new Date().getFullYear().toString();
const currentMonth = () => `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`;

export function buildMultiDimensionQueries(keyword: string, industry: string, platforms: string[]): string[] {
  const queries: string[] = [
    `${industry} ${keyword} 最新进展 ${currentMonth()}`,
    `${industry} ${keyword} 争议 讨论`,
    `${industry} ${keyword} 报告 数据 ${currentYear()}`,
    `${keyword} 教程 踩坑 经验`,
    `${keyword} 最新趋势 ${currentYear()}`,
  ];

  for (const p of platforms.slice(0, 2)) {
    queries.push(`${keyword} ${p} 爆款`);
  }

  return queries;
}

/**
 * Web search collector. Requires caller to provide a search function
 * since the actual web_search tool is invoked by the LLM, not by code.
 * This collector builds queries and transforms results into IntelItems.
 */
export function createWebSearchCollector(
  searchFn: (query: string) => Promise<Array<{ title: string; snippet: string; url: string }>>
): Collector {
  return {
    id: "web_search",
    async collect(opts: CollectorOptions): Promise<CollectorResult> {
      const queries = buildMultiDimensionQueries(
        opts.keywords[0] ?? "",
        opts.industry,
        opts.platforms
      );

      const items: IntelItem[] = [];
      const errors: string[] = [];

      for (const query of queries) {
        try {
          const results = await searchFn(query);
          for (const r of results) {
            items.push({
              title: r.title,
              domain: opts.industry,
              source: "web_search",
              sourceUrl: r.url,
              collectedAt: now(),
              relevance: 0.5, // To be scored later by LLM
              tags: opts.keywords,
              expiresAfter: "30d",
              summary: r.snippet,
              keyPoints: [],
              topicPotential: [],
            });
          }
        } catch (err) {
          errors.push(`Search failed for "${query}": ${err}`);
        }
      }

      return { items, source: "web_search", errors };
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/intel/collectors/web-search.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/intel/
git commit -m "feat: add collector interface and web search collector"
```

---

## Task 8: RSS Collector

**Files:**
- Create: `src/modules/intel/collectors/rss.ts`
- Create: `src/modules/intel/collectors/rss.test.ts`

**Step 1: Write the failing test**

```typescript
// src/modules/intel/collectors/rss.test.ts
import { describe, it, expect } from "vitest";
import { parseRssItems } from "./rss.js";

describe("rss collector", () => {
  it("transforms RSS items into IntelItems", () => {
    const rssItems = [
      {
        title: "Cursor 发布 Agent 模式",
        link: "https://example.com/post/1",
        contentSnippet: "Cursor 正式发布了 Agent 模式，支持自主编程...",
        isoDate: "2026-04-03T08:00:00Z",
      },
    ];

    const items = parseRssItems(rssItems, "效率工具", ["AI", "编程"]);
    expect(items.length).toBe(1);
    expect(items[0].source).toBe("rss");
    expect(items[0].domain).toBe("效率工具");
    expect(items[0].title).toBe("Cursor 发布 Agent 模式");
  });

  it("handles items with missing fields gracefully", () => {
    const rssItems = [{ title: "No link item" }];
    const items = parseRssItems(rssItems as any, "科技", []);
    expect(items.length).toBe(1);
    expect(items[0].sourceUrl).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/intel/collectors/rss.test.ts`
Expected: FAIL.

**Step 3: Implement RSS collector**

```typescript
// src/modules/intel/collectors/rss.ts
import Parser from "rss-parser";
import type { Collector, CollectorOptions, CollectorResult } from "../collector.js";
import type { IntelItem } from "../../../storage/pipeline-store.js";
import { loadSourceConfig } from "../source-config.js";

const parser = new Parser();

export interface RssItem {
  title?: string;
  link?: string;
  contentSnippet?: string;
  isoDate?: string;
}

export function parseRssItems(items: RssItem[], domain: string, tags: string[]): IntelItem[] {
  return items.map((item) => ({
    title: item.title ?? "Untitled",
    domain,
    source: "rss" as const,
    sourceUrl: item.link,
    collectedAt: item.isoDate ?? new Date().toISOString(),
    relevance: 0.5,
    tags,
    expiresAfter: "30d",
    summary: item.contentSnippet ?? "",
    keyPoints: [],
    topicPotential: [],
  }));
}

export function createRssCollector(): Collector {
  return {
    id: "rss",
    async collect(opts: CollectorOptions): Promise<CollectorResult> {
      const config = loadSourceConfig(opts.dataDir);
      const items: IntelItem[] = [];
      const errors: string[] = [];

      for (const feed of config.rss.feeds) {
        try {
          const parsed = await parser.parseURL(feed.url);
          const feedItems = parseRssItems(
            parsed.items.slice(0, 20),
            feed.domain,
            feed.tags ?? []
          );
          items.push(...feedItems);
        } catch (err) {
          errors.push(`RSS fetch failed for ${feed.url}: ${err}`);
        }
      }

      return { items, source: "rss", errors };
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/intel/collectors/rss.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/intel/collectors/rss.ts src/modules/intel/collectors/rss.test.ts
git commit -m "feat: add RSS collector with feed parsing"
```

---

## Task 9: Trend Collector (Platform Hot Lists)

**Files:**
- Create: `src/modules/intel/collectors/trends.ts`
- Create: `src/modules/intel/collectors/trends.test.ts`

This collector fetches public hot lists. Uses web search as the transport (LLM-driven), similar to how the existing research module works.

**Step 1: Write the failing test**

```typescript
// src/modules/intel/collectors/trends.test.ts
import { describe, it, expect } from "vitest";
import { buildTrendQueries } from "./trends.js";

describe("trend collector", () => {
  it("builds platform-specific trend queries", () => {
    const queries = buildTrendQueries([
      { source: "hackernews", enabled: true },
      { source: "weibo_hot", enabled: true },
      { source: "reddit", enabled: true, subreddits: ["ChatGPT"] },
    ], ["AI"]);

    expect(queries.length).toBeGreaterThanOrEqual(3);
    expect(queries.some((q) => q.includes("Hacker News"))).toBe(true);
    expect(queries.some((q) => q.includes("微博热搜"))).toBe(true);
    expect(queries.some((q) => q.includes("reddit"))).toBe(true);
  });

  it("skips disabled sources", () => {
    const queries = buildTrendQueries([
      { source: "hackernews", enabled: false },
      { source: "weibo_hot", enabled: true },
    ], []);

    expect(queries.some((q) => q.includes("Hacker News"))).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/intel/collectors/trends.test.ts`
Expected: FAIL.

**Step 3: Implement trend collector**

```typescript
// src/modules/intel/collectors/trends.ts
import type { Collector, CollectorOptions, CollectorResult } from "../collector.js";
import type { IntelItem } from "../../../storage/pipeline-store.js";
import type { TrendSource } from "../source-config.js";
import { loadSourceConfig } from "../source-config.js";

const PLATFORM_QUERY_MAP: Record<string, (src: TrendSource, keywords: string[]) => string> = {
  hackernews: () => "Hacker News top stories today",
  producthunt: () => "Product Hunt trending today",
  github_trending: () => "GitHub trending repositories today",
  weibo_hot: () => "微博热搜 今日",
  zhihu_hot: () => "知乎热榜 今日",
  douyin_hot: () => "抖音热榜 今日",
  bilibili_hot: () => "B站热门 今日",
  toutiao_hot: () => "今日头条热榜",
  twitter_trending: (src) => `Twitter trending ${src.region ?? "worldwide"} today`,
  reddit: (src) => `reddit ${(src.subreddits ?? []).join(" ")} top posts today`,
  google_trends: (src, kw) => `Google Trends ${[...(src.keywords ?? []), ...kw].join(" ")}`,
  arxiv: (src) => `arxiv recent papers ${(src.categories ?? []).join(" ")}`,
  youtube_trending: () => "YouTube trending today",
};

export function buildTrendQueries(sources: TrendSource[], keywords: string[]): string[] {
  return sources
    .filter((s) => s.enabled !== false)
    .map((s) => {
      const builder = PLATFORM_QUERY_MAP[s.source];
      return builder ? builder(s, keywords) : `${s.source} trending today`;
    });
}

export function createTrendCollector(
  searchFn: (query: string) => Promise<Array<{ title: string; snippet: string; url: string }>>
): Collector {
  return {
    id: "trend",
    async collect(opts: CollectorOptions): Promise<CollectorResult> {
      const config = loadSourceConfig(opts.dataDir);
      const queries = buildTrendQueries(config.trends.sources, opts.keywords);
      const items: IntelItem[] = [];
      const errors: string[] = [];

      for (const query of queries) {
        try {
          const results = await searchFn(query);
          for (const r of results) {
            items.push({
              title: r.title,
              domain: opts.industry,
              source: "trend",
              sourceUrl: r.url,
              collectedAt: new Date().toISOString(),
              relevance: 0.5,
              tags: opts.keywords,
              expiresAfter: "7d", // Trends expire faster
              summary: r.snippet,
              keyPoints: [],
              topicPotential: [],
            });
          }
        } catch (err) {
          errors.push(`Trend search failed for "${query}": ${err}`);
        }
      }

      return { items, source: "trend", errors };
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/intel/collectors/trends.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/intel/collectors/trends.ts src/modules/intel/collectors/trends.test.ts
git commit -m "feat: add trend collector with platform hot list queries"
```

---

## Task 10: Competitor Collector (Browser CDP)

**Files:**
- Create: `src/modules/intel/collectors/competitor.ts`
- Create: `src/modules/intel/collectors/competitor.test.ts`

Wraps existing `browser-cdp` adapter for competitor monitoring.

**Step 1: Write the failing test**

```typescript
// src/modules/intel/collectors/competitor.test.ts
import { describe, it, expect } from "vitest";
import { transformCompetitorResults } from "./competitor.js";

describe("competitor collector", () => {
  it("transforms browser research items to intel items", () => {
    const browserResults = [
      { title: "竞品最新文章", url: "https://xiaohongshu.com/explore/xxx", author: "花爷" },
    ];

    const items = transformCompetitorResults(browserResults, "花爷", "职场", "xiaohongshu");
    expect(items.length).toBe(1);
    expect(items[0].source).toBe("competitor");
    expect(items[0].domain).toBe("职场");
    expect(items[0].tags).toContain("competitor:花爷");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/intel/collectors/competitor.test.ts`
Expected: FAIL.

**Step 3: Implement competitor collector**

```typescript
// src/modules/intel/collectors/competitor.ts
import type { Collector, CollectorOptions, CollectorResult } from "../collector.js";
import type { IntelItem } from "../../../storage/pipeline-store.js";
import { loadSourceConfig } from "../source-config.js";
import { browserCdpAdapter } from "../../../adapters/browser/browser-cdp.js";

interface BrowserResult {
  title: string;
  url: string;
  author?: string;
}

export function transformCompetitorResults(
  results: BrowserResult[],
  accountName: string,
  domain: string,
  platform: string
): IntelItem[] {
  return results.map((r) => ({
    title: r.title,
    domain,
    source: "competitor" as const,
    sourceUrl: r.url,
    collectedAt: new Date().toISOString(),
    relevance: 0.7, // Competitor content is inherently relevant
    tags: [`competitor:${accountName}`, platform],
    expiresAfter: "30d",
    summary: `来自 ${accountName} (${platform}) 的内容`,
    keyPoints: [],
    topicPotential: [],
  }));
}

export function createCompetitorCollector(): Collector {
  return {
    id: "competitor",
    async collect(opts: CollectorOptions): Promise<CollectorResult> {
      const config = loadSourceConfig(opts.dataDir);
      const items: IntelItem[] = [];
      const errors: string[] = [];

      for (const account of config.accounts.accounts) {
        try {
          const status = await browserCdpAdapter.getSessionStatus(account.platform);
          if (!status.loggedIn) {
            errors.push(`Not logged in to ${account.platform}, skipping ${account.name}`);
            continue;
          }

          const results = await browserCdpAdapter.research(`${account.name} 最新内容`);
          const transformed = transformCompetitorResults(
            results as BrowserResult[],
            account.name,
            account.domain,
            account.platform
          );
          items.push(...transformed);
        } catch (err) {
          errors.push(`Competitor fetch failed for ${account.name}: ${err}`);
        }
      }

      return { items, source: "competitor", errors };
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/intel/collectors/competitor.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/intel/collectors/competitor.ts src/modules/intel/collectors/competitor.test.ts
git commit -m "feat: add competitor collector using browser-cdp adapter"
```

---

## Task 11: Intel Engine Orchestrator

**Files:**
- Create: `src/modules/intel/intel-engine.ts`
- Create: `src/modules/intel/intel-engine.test.ts`

Orchestrates all collectors, deduplicates, and saves to pipeline.

**Step 1: Write the failing test**

```typescript
// src/modules/intel/intel-engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runIntelPull } from "./intel-engine.js";
import { initPipeline, listIntel } from "../../storage/pipeline-store.js";

describe("intel-engine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-test-"));
    initPipeline(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs collectors and saves results to intel/", async () => {
    const mockSearchFn = async () => [
      { title: "Test Result", snippet: "A test intel item", url: "https://example.com" },
    ];

    const result = await runIntelPull({
      keywords: ["AI"],
      industry: "科技",
      platforms: ["xiaohongshu"],
      dataDir: tmpDir,
      searchFn: mockSearchFn,
      skipBrowser: true, // Skip competitor collector in tests
    });

    expect(result.totalSaved).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    const items = listIntel("科技", tmpDir);
    expect(items.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/intel/intel-engine.test.ts`
Expected: FAIL.

**Step 3: Implement intel engine orchestrator**

```typescript
// src/modules/intel/intel-engine.ts
import type { Collector, CollectorResult } from "./collector.js";
import { createWebSearchCollector } from "./collectors/web-search.js";
import { createRssCollector } from "./collectors/rss.js";
import { createTrendCollector } from "./collectors/trends.js";
import { createCompetitorCollector } from "./collectors/competitor.js";
import { saveIntel, type IntelItem } from "../../storage/pipeline-store.js";

export interface IntelPullOptions {
  keywords: string[];
  industry: string;
  platforms: string[];
  dataDir?: string;
  searchFn: (query: string) => Promise<Array<{ title: string; snippet: string; url: string }>>;
  skipBrowser?: boolean;
  sources?: string[]; // Filter to specific sources, e.g. ["rss"]
}

export interface IntelPullResult {
  totalCollected: number;
  totalSaved: number;
  bySource: Record<string, number>;
  errors: string[];
}

export async function runIntelPull(opts: IntelPullOptions): Promise<IntelPullResult> {
  const collectors: Collector[] = [];

  const shouldRun = (id: string) => !opts.sources || opts.sources.includes(id);

  if (shouldRun("web_search")) {
    collectors.push(createWebSearchCollector(opts.searchFn));
  }
  if (shouldRun("rss")) {
    collectors.push(createRssCollector());
  }
  if (shouldRun("trend")) {
    collectors.push(createTrendCollector(opts.searchFn));
  }
  if (shouldRun("competitor") && !opts.skipBrowser) {
    collectors.push(createCompetitorCollector());
  }

  const allItems: IntelItem[] = [];
  const allErrors: string[] = [];
  const bySource: Record<string, number> = {};

  // Run collectors in parallel
  const results = await Promise.allSettled(
    collectors.map((c) =>
      c.collect({
        keywords: opts.keywords,
        industry: opts.industry,
        platforms: opts.platforms,
        dataDir: opts.dataDir,
      })
    )
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const r: CollectorResult = result.value;
      allItems.push(...r.items);
      allErrors.push(...r.errors);
      bySource[r.source] = r.items.length;
    } else {
      allErrors.push(`Collector failed: ${result.reason}`);
    }
  }

  // Save to pipeline (dedup handled by saveIntel)
  let saved = 0;
  for (const item of allItems) {
    try {
      saveIntel(item, opts.dataDir);
      saved++;
    } catch (err) {
      allErrors.push(`Save failed for "${item.title}": ${err}`);
    }
  }

  return {
    totalCollected: allItems.length,
    totalSaved: saved,
    bySource,
    errors: allErrors,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/intel/intel-engine.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/modules/intel/intel-engine.ts src/modules/intel/intel-engine.test.ts
git commit -m "feat: add intel engine orchestrator — parallel collectors with dedup"
```

---

## Task 12: autocrew_intel Tool

**Files:**
- Create: `src/tools/intel.ts`
- Modify: `src/tools/registry.ts` — register new tool

**Step 1: Create the tool**

```typescript
// src/tools/intel.ts
import { Type } from "@sinclair/typebox";
import { runIntelPull } from "../modules/intel/intel-engine.js";
import { listIntel, archiveExpiredIntel } from "../storage/pipeline-store.js";
import { loadProfile } from "../modules/profile/creator-profile.js";

export const intelSchema = Type.Object({
  action: Type.Unsafe<"pull" | "list" | "clean">({
    type: "string",
    enum: ["pull", "list", "clean"],
    description: "pull: fetch from all sources. list: show intel. clean: archive expired.",
  }),
  domain: Type.Optional(Type.String({ description: "Filter by domain" })),
  source: Type.Optional(Type.String({ description: "Filter to specific source: rss, web_search, trend, competitor" })),
  keywords: Type.Optional(Type.Array(Type.String(), { description: "Override keywords for pull" })),
  _dataDir: Type.Optional(Type.String()),
});

export async function executeIntel(params: {
  action: string;
  domain?: string;
  source?: string;
  keywords?: string[];
  _dataDir?: string;
  _searchFn?: (query: string) => Promise<Array<{ title: string; snippet: string; url: string }>>;
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const dataDir = params._dataDir;

  switch (params.action) {
    case "pull": {
      const profile = loadProfile(dataDir);
      if (!profile) return { ok: false, error: "Creator profile not found. Run autocrew init first." };

      if (!params._searchFn) {
        return { ok: false, error: "Search function not provided. This tool must be called via Agent." };
      }

      const result = await runIntelPull({
        keywords: params.keywords ?? [profile.industry],
        industry: profile.industry,
        platforms: profile.platforms,
        dataDir,
        searchFn: params._searchFn,
        sources: params.source ? [params.source] : undefined,
      });

      return { ok: true, data: result };
    }

    case "list": {
      const items = listIntel(params.domain, dataDir);
      return {
        ok: true,
        data: {
          count: items.length,
          items: items.slice(0, 50).map((i) => ({
            title: i.title,
            domain: i.domain,
            source: i.source,
            collectedAt: i.collectedAt,
            relevance: i.relevance,
          })),
        },
      };
    }

    case "clean": {
      const archived = archiveExpiredIntel(dataDir);
      return { ok: true, data: { archived } };
    }

    default:
      return { ok: false, error: `Unknown action: ${params.action}` };
  }
}
```

**Step 2: Register in registry.ts**

Add to `src/tools/registry.ts`, alongside existing tool registrations:

```typescript
import { intelSchema, executeIntel } from "./intel.js";

// Inside registerAllTools():
runner.register({
  name: "autocrew_intel",
  label: "情报采集",
  description: "采集、查看、清理情报库。pull: 从所有信息源拉取最新情报; list: 查看情报库; clean: 清理过期情报",
  parameters: intelSchema,
  execute: async (_id, params) => executeIntel(params as any),
});
```

**Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/tools/intel.ts src/tools/registry.ts
git commit -m "feat: add autocrew_intel tool — pull, list, clean actions"
```

---

## Task 13: autocrew_pipeline Tool

**Files:**
- Create: `src/tools/pipeline-ops.ts`
- Modify: `src/tools/registry.ts`

**Step 1: Create the tool**

```typescript
// src/tools/pipeline-ops.ts
import { Type } from "@sinclair/typebox";
import {
  initPipeline,
  startProject,
  advanceProject,
  addDraftVersion,
  trashProject,
  restoreProject,
  getProjectMeta,
  listProjects,
  PIPELINE_STAGES,
  type PipelineStage,
} from "../storage/pipeline-store.js";
import { listIntel, listTopics } from "../storage/pipeline-store.js";

export const pipelineOpsSchema = Type.Object({
  action: Type.Unsafe<"start" | "advance" | "ready" | "publish" | "trash" | "restore" | "status" | "version">({
    type: "string",
    enum: ["start", "advance", "ready", "publish", "trash", "restore", "status", "version"],
  }),
  project: Type.Optional(Type.String({ description: "Project name/slug" })),
  platform: Type.Optional(Type.String({ description: "Target platform(s), comma-separated" })),
  content: Type.Optional(Type.String({ description: "Draft content for version action" })),
  note: Type.Optional(Type.String({ description: "Version note" })),
  _dataDir: Type.Optional(Type.String()),
});

export async function executePipelineOps(params: {
  action: string;
  project?: string;
  platform?: string;
  content?: string;
  note?: string;
  _dataDir?: string;
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const dataDir = params._dataDir;

  switch (params.action) {
    case "status": {
      initPipeline(dataDir);
      const intel = listIntel(undefined, dataDir);
      const topics = listTopics(undefined, dataDir);
      const drafting = listProjects("drafting", dataDir);
      const production = listProjects("production", dataDir);
      const published = listProjects("published", dataDir);
      const trash = listProjects("trash", dataDir);

      return {
        ok: true,
        data: {
          intel: intel.length,
          topics: topics.length,
          drafting: drafting.length,
          production: production.length,
          published: published.length,
          trash: trash.length,
          projects: {
            drafting,
            production,
          },
        },
      };
    }

    case "start": {
      if (!params.project) return { ok: false, error: "project name required" };
      const dir = startProject(params.project, dataDir);
      return { ok: true, data: { projectDir: dir } };
    }

    case "advance": {
      if (!params.project) return { ok: false, error: "project name required" };
      const dir = advanceProject(params.project, dataDir);
      return { ok: true, data: { projectDir: dir } };
    }

    case "version": {
      if (!params.project) return { ok: false, error: "project name required" };
      if (!params.content) return { ok: false, error: "content required" };
      const file = addDraftVersion(params.project, params.content, params.note ?? "", dataDir);
      return { ok: true, data: { versionFile: file } };
    }

    case "trash": {
      if (!params.project) return { ok: false, error: "project name required" };
      trashProject(params.project, dataDir);
      return { ok: true, data: { trashed: params.project } };
    }

    case "restore": {
      if (!params.project) return { ok: false, error: "project name required" };
      restoreProject(params.project, dataDir);
      return { ok: true, data: { restored: params.project } };
    }

    default:
      return { ok: false, error: `Unknown action: ${params.action}` };
  }
}
```

**Step 2: Register in registry.ts**

```typescript
import { pipelineOpsSchema, executePipelineOps } from "./pipeline-ops.js";

// Inside registerAllTools():
runner.register({
  name: "autocrew_pipeline",
  label: "内容管线",
  description: "管理内容管线流转。start: 从选题开始创作; advance: 推进到下一阶段; version: 新增草稿版本; trash/restore: 回收/恢复; status: 全局看板",
  parameters: pipelineOpsSchema,
  execute: async (_id, params) => executePipelineOps(params as any),
});
```

**Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/tools/pipeline-ops.ts src/tools/registry.ts
git commit -m "feat: add autocrew_pipeline tool — start, advance, version, trash, status"
```

---

## Task 14: CLI Commands — intel, start, advance

**Files:**
- Create: `src/cli/commands/intel.ts`
- Create: `src/cli/commands/start.ts`
- Create: `src/cli/commands/advance.ts`
- Modify: `src/cli/commands/index.ts` — register new commands
- Modify: `src/cli/commands/status.ts` — update to use pipeline status

**Step 1: Create intel CLI command**

```typescript
// src/cli/commands/intel.ts
import type { Command } from "commander";
import { bootstrap } from "../bootstrap.js";

export function registerIntelCommand(program: Command) {
  const intel = program.command("intel").description("情报采集与管理");

  intel
    .command("pull")
    .description("拉取所有订阅源最新情报")
    .option("--source <source>", "只拉取指定源: rss, web_search, trend, competitor")
    .action(async (opts) => {
      const { runner } = bootstrap();
      const result = await runner.execute("autocrew_intel", {
        action: "pull",
        source: opts.source,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  intel
    .command("list")
    .description("查看情报库")
    .option("--domain <domain>", "按领域筛选")
    .action(async (opts) => {
      const { runner } = bootstrap();
      const result = await runner.execute("autocrew_intel", {
        action: "list",
        domain: opts.domain,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  intel
    .command("clean")
    .description("清理过期情报")
    .action(async () => {
      const { runner } = bootstrap();
      const result = await runner.execute("autocrew_intel", { action: "clean" });
      console.log(JSON.stringify(result, null, 2));
    });
}
```

**Step 2: Create start and advance CLI commands**

```typescript
// src/cli/commands/start.ts
import type { Command } from "commander";
import { bootstrap } from "../bootstrap.js";

export function registerStartCommand(program: Command) {
  program
    .command("start <topic>")
    .description("从选题池开始创作")
    .action(async (topic) => {
      const { runner } = bootstrap();
      const result = await runner.execute("autocrew_pipeline", {
        action: "start",
        project: topic,
      });
      console.log(JSON.stringify(result, null, 2));
    });
}
```

```typescript
// src/cli/commands/advance.ts
import type { Command } from "commander";
import { bootstrap } from "../bootstrap.js";

export function registerAdvanceCommand(program: Command) {
  program
    .command("advance <project>")
    .description("推进项目到下一阶段")
    .action(async (project) => {
      const { runner } = bootstrap();
      const result = await runner.execute("autocrew_pipeline", {
        action: "advance",
        project,
      });
      console.log(JSON.stringify(result, null, 2));
    });
}
```

**Step 3: Register in commands/index.ts**

Add imports and registration calls for `registerIntelCommand`, `registerStartCommand`, `registerAdvanceCommand`.

**Step 4: Run smoke test**

```bash
npx tsx src/cli/index.ts intel --help
npx tsx src/cli/index.ts start --help
npx tsx src/cli/index.ts advance --help
```

Expected: Help text for each command.

**Step 5: Commit**

```bash
git add src/cli/commands/intel.ts src/cli/commands/start.ts src/cli/commands/advance.ts src/cli/commands/index.ts
git commit -m "feat: add intel, start, advance CLI commands"
```

---

## Task 15: Data Migration Command

**Files:**
- Create: `src/cli/commands/migrate.ts`
- Create: `src/modules/migrate/legacy-migrate.ts`
- Create: `src/modules/migrate/legacy-migrate.test.ts`

Migrates old `~/.autocrew/topics/*.json` and `~/.autocrew/contents/*/meta.json` to the new `pipeline/` structure.

**Step 1: Write the failing test**

```typescript
// src/modules/migrate/legacy-migrate.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrateLegacyData } from "./legacy-migrate.js";

describe("legacy-migrate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates legacy topic JSON to pipeline/topics/ markdown", () => {
    // Create legacy topic
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    fs.writeFileSync(
      path.join(topicsDir, "topic-123.json"),
      JSON.stringify({
        id: "topic-123",
        title: "AI编程入门",
        description: "一篇关于AI编程的入门文章",
        tags: ["AI", "编程"],
        source: "web_search",
        createdAt: "2026-04-01T00:00:00Z",
      }),
      "utf-8"
    );

    const result = migrateLegacyData(tmpDir);
    expect(result.topicsMigrated).toBe(1);

    // Check new file exists
    const pipelineTopics = path.join(tmpDir, "pipeline", "topics");
    const files = fs.readdirSync(pipelineTopics);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.md$/);
  });

  it("migrates legacy content to pipeline drafting/", () => {
    // Create legacy content
    const contentDir = path.join(tmpDir, "contents", "content-456");
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(
      path.join(contentDir, "meta.json"),
      JSON.stringify({
        id: "content-456",
        title: "AI编程实操",
        status: "drafting",
        body: "文章内容...",
        createdAt: "2026-04-02T00:00:00Z",
      }),
      "utf-8"
    );
    fs.writeFileSync(path.join(contentDir, "draft.md"), "文章内容...", "utf-8");

    const result = migrateLegacyData(tmpDir);
    expect(result.contentsMigrated).toBe(1);

    const draftingDir = path.join(tmpDir, "pipeline", "drafting");
    const projects = fs.readdirSync(draftingDir);
    expect(projects.length).toBe(1);
  });

  it("is idempotent — running twice doesn't duplicate", () => {
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    fs.writeFileSync(
      path.join(topicsDir, "topic-789.json"),
      JSON.stringify({ id: "topic-789", title: "Test", description: "", tags: [], createdAt: "2026-04-01T00:00:00Z" }),
      "utf-8"
    );

    migrateLegacyData(tmpDir);
    const result2 = migrateLegacyData(tmpDir);
    expect(result2.topicsMigrated).toBe(0); // Already migrated
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/migrate/legacy-migrate.test.ts`
Expected: FAIL.

**Step 3: Implement migration**

```typescript
// src/modules/migrate/legacy-migrate.ts
import fs from "node:fs";
import path from "node:path";
import { initPipeline, saveTopic, type TopicCandidate } from "../../storage/pipeline-store.js";
import yaml from "js-yaml";

export interface MigrationResult {
  topicsMigrated: number;
  contentsMigrated: number;
  errors: string[];
}

function mapLegacyStatus(status: string): string {
  const map: Record<string, string> = {
    topic_saved: "topics",
    drafting: "drafting",
    draft_ready: "drafting",
    reviewing: "drafting",
    revision: "drafting",
    approved: "production",
    cover_pending: "production",
    publish_ready: "production",
    publishing: "production",
    published: "published",
    archived: "trash",
  };
  return map[status] ?? "drafting";
}

export function migrateLegacyData(dataDir: string): MigrationResult {
  initPipeline(dataDir);

  const result: MigrationResult = { topicsMigrated: 0, contentsMigrated: 0, errors: [] };

  // --- Migrate topics ---
  const legacyTopicsDir = path.join(dataDir, "topics");
  if (fs.existsSync(legacyTopicsDir)) {
    const files = fs.readdirSync(legacyTopicsDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(legacyTopicsDir, f), "utf-8"));

        // Check if already migrated (look for matching title in pipeline/topics/)
        const pipelineTopicsDir = path.join(dataDir, "pipeline", "topics");
        const existing = fs.existsSync(pipelineTopicsDir)
          ? fs.readdirSync(pipelineTopicsDir).filter((t) => t.endsWith(".md"))
          : [];
        const alreadyMigrated = existing.some((t) =>
          t.toLowerCase().includes((raw.title ?? "").toLowerCase().slice(0, 10).replace(/[^\p{L}\p{N}]+/gu, "-"))
        );
        if (alreadyMigrated) continue;

        const topic: TopicCandidate = {
          title: raw.title ?? raw.id,
          domain: raw.tags?.[0] ?? "未分类",
          score: {
            heat: raw.viralScore ?? 50,
            differentiation: 50,
            audienceFit: 50,
            overall: raw.viralScore ?? 50,
          },
          formats: [],
          suggestedPlatforms: [],
          createdAt: raw.createdAt ?? new Date().toISOString(),
          intelRefs: [],
          angles: [],
          audienceResonance: [],
          references: [],
        };

        saveTopic(topic, dataDir);
        result.topicsMigrated++;
      } catch (err) {
        result.errors.push(`Topic migration failed for ${f}: ${err}`);
      }
    }
  }

  // --- Migrate contents ---
  const legacyContentsDir = path.join(dataDir, "contents");
  if (fs.existsSync(legacyContentsDir)) {
    const dirs = fs.readdirSync(legacyContentsDir).filter((d) =>
      fs.statSync(path.join(legacyContentsDir, d)).isDirectory()
    );

    for (const d of dirs) {
      try {
        const metaPath = path.join(legacyContentsDir, d, "meta.json");
        if (!fs.existsSync(metaPath)) continue;

        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const stage = mapLegacyStatus(meta.status ?? "drafting");
        const projectName = (meta.title ?? d).replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60);
        const targetDir = path.join(dataDir, "pipeline", stage, projectName);

        // Check if already migrated
        if (fs.existsSync(targetDir)) continue;

        // Copy entire directory
        fs.mkdirSync(targetDir, { recursive: true });
        const files = fs.readdirSync(path.join(legacyContentsDir, d));
        for (const file of files) {
          const src = path.join(legacyContentsDir, d, file);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, path.join(targetDir, file));
          }
        }

        // Convert meta.json → meta.yaml
        const newMeta = {
          title: meta.title ?? d,
          domain: meta.tags?.[0] ?? "未分类",
          format: "text",
          createdAt: meta.createdAt ?? new Date().toISOString(),
          sourceTopic: "",
          intelRefs: [],
          versions: [{ file: "draft.md", createdAt: meta.createdAt ?? new Date().toISOString(), note: "迁移自旧版本" }],
          current: "draft.md",
          history: [{ stage, entered: new Date().toISOString() }],
          platforms: {},
        };
        fs.writeFileSync(path.join(targetDir, "meta.yaml"), yaml.dump(newMeta, { lineWidth: -1 }), "utf-8");

        // Rename draft.md to draft-v1.md, keep draft.md as current
        const draftPath = path.join(targetDir, "draft.md");
        if (fs.existsSync(draftPath)) {
          fs.copyFileSync(draftPath, path.join(targetDir, "draft-v1.md"));
        }

        result.contentsMigrated++;
      } catch (err) {
        result.errors.push(`Content migration failed for ${d}: ${err}`);
      }
    }
  }

  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/migrate/legacy-migrate.test.ts`
Expected: PASS.

**Step 5: Create CLI command**

```typescript
// src/cli/commands/migrate.ts
import type { Command } from "commander";
import { migrateLegacyData } from "../../modules/migrate/legacy-migrate.js";
import os from "node:os";
import path from "node:path";

export function registerMigrateCommand(program: Command) {
  program
    .command("migrate")
    .description("迁移旧版数据到新管线结构（一次性，幂等）")
    .action(() => {
      const dataDir = path.join(os.homedir(), ".autocrew");
      const result = migrateLegacyData(dataDir);
      console.log(`迁移完成: ${result.topicsMigrated} 个选题, ${result.contentsMigrated} 个内容`);
      if (result.errors.length) {
        console.log(`错误: ${result.errors.join("\n")}`);
      }
    });
}
```

Register in `commands/index.ts`.

**Step 6: Run all tests**

Run: `npm test`
Expected: All pass.

**Step 7: Commit**

```bash
git add src/modules/migrate/ src/cli/commands/migrate.ts src/cli/commands/index.ts
git commit -m "feat: add legacy data migration — topics JSON + contents to pipeline structure"
```

---

## Task 16: Update autocrew init to Create Pipeline Structure

**Files:**
- Modify: `src/tools/init.ts`

**Step 1: Read current init tool**

Read `src/tools/init.ts` to understand current initialization flow.

**Step 2: Add pipeline initialization**

Add `initPipeline(dataDir)` call to the existing `executeInit()` function, after the existing directory creation logic. Import from `../storage/pipeline-store.js`.

**Step 3: Run all tests**

Run: `npm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/tools/init.ts
git commit -m "feat: init command now creates pipeline directory structure"
```

---

## Task 17: Update Skills

**Files:**
- Create: `skills/intel-pull/SKILL.md`
- Create: `skills/intel-digest/SKILL.md`
- Create: `skills/pipeline-status/SKILL.md`
- Modify: `skills/research/SKILL.md` — update to intel-first flow

**Step 1: Create intel-pull skill**

```markdown
---
name: intel-pull
description: 拉取最新情报 — 从所有订阅源采集信息并归档到情报库
triggers:
  - "最新资讯"
  - "拉取情报"
  - "有什么新消息"
  - "更新情报"
invokable: true
---

# 情报拉取

## 执行流程

1. 检查 creator-profile.json 是否存在，不存在则先引导 onboarding
2. 调用 `autocrew_intel` tool，action: `pull`
3. 展示采集结果摘要：
   - 各信息源采集数量
   - 新增情报条目
   - 按领域分组展示标题列表
4. 询问用户是否要从新情报中提炼选题

## 展示格式

采集完成后按以下格式展示：

> 📥 情报更新完成
> - Web Search: X 条
> - RSS: X 条
> - 热榜趋势: X 条
>
> **AI编程** (3 条新增)
> 1. Cursor 发布 Agent 模式
> 2. Claude Code 新增 Hooks 功能
> 3. GitHub Copilot 降价
>
> 需要从这些情报中提炼选题吗？
```

**Step 2: Create intel-digest and pipeline-status skills**

Similar structure — `intel-digest` summarizes the week's intel, `pipeline-status` calls `autocrew_pipeline` with action `status` and formats the kanban view.

**Step 3: Update research skill**

Modify `skills/research/SKILL.md` to change the flow: research now first runs `autocrew_intel pull`, then uses accumulated intel to generate topics via `autocrew topics generate`.

**Step 4: Commit**

```bash
git add skills/
git commit -m "feat: add intel-pull, intel-digest, pipeline-status skills; update research flow"
```

---

## Task 18: Integration Test

**Files:**
- Create: `src/modules/intel/integration.test.ts`

**Step 1: Write integration test**

```typescript
// src/modules/intel/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initPipeline,
  saveIntel,
  saveTopic,
  listIntel,
  listTopics,
  startProject,
  advanceProject,
  addDraftVersion,
  getProjectMeta,
  listProjects,
  trashProject,
  restoreProject,
} from "../../storage/pipeline-store.js";

describe("full pipeline flow", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-integ-"));
    initPipeline(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("intel → topic → draft → production → published", () => {
    // 1. Save intel
    saveIntel({
      title: "Cursor Agent",
      domain: "AI编程",
      source: "rss",
      collectedAt: new Date().toISOString(),
      relevance: 0.9,
      tags: ["Cursor"],
      expiresAfter: "30d",
      summary: "Cursor released agent mode",
      keyPoints: ["multi-file editing"],
      topicPotential: ["comparison article"],
    }, tmpDir);

    expect(listIntel("AI编程", tmpDir).length).toBe(1);

    // 2. Create topic from intel
    saveTopic({
      title: "Cursor 深度体验",
      domain: "AI编程",
      score: { heat: 85, differentiation: 70, audienceFit: 90, overall: 82 },
      formats: ["image-text"],
      suggestedPlatforms: ["xiaohongshu"],
      createdAt: new Date().toISOString().slice(0, 10),
      intelRefs: ["intel/AI编程/cursor-agent.md"],
      angles: ["实操体验"],
      audienceResonance: [],
      references: [],
    }, tmpDir);

    expect(listTopics(undefined, tmpDir).length).toBe(1);

    // 3. Start project
    const projectDir = startProject("ai编程-cursor-深度体验", tmpDir);
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(listTopics(undefined, tmpDir).length).toBe(0); // Topic consumed

    // 4. Add draft version
    addDraftVersion("ai编程-cursor-深度体验", "改进版内容", "改进开头", tmpDir);
    const meta = getProjectMeta("ai编程-cursor-深度体验", tmpDir);
    expect(meta!.versions.length).toBe(2);
    expect(meta!.current).toBe("draft-v2.md");

    // 5. Advance to production
    advanceProject("ai编程-cursor-深度体验", tmpDir);
    expect(listProjects("production", tmpDir)).toContain("ai编程-cursor-深度体验");
    expect(listProjects("drafting", tmpDir).length).toBe(0);

    // 6. Advance to published
    advanceProject("ai编程-cursor-深度体验", tmpDir);
    expect(listProjects("published", tmpDir)).toContain("ai编程-cursor-深度体验");

    // 7. Verify history
    const finalMeta = getProjectMeta("ai编程-cursor-深度体验", tmpDir);
    expect(finalMeta!.history.length).toBe(4); // topics → drafting → production → published
  });

  it("trash and restore preserves state", () => {
    saveTopic({
      title: "Trash test",
      domain: "测试",
      score: { heat: 50, differentiation: 50, audienceFit: 50, overall: 50 },
      formats: [],
      suggestedPlatforms: [],
      createdAt: "2026-04-03",
      intelRefs: [],
      angles: [],
      audienceResonance: [],
      references: [],
    }, tmpDir);

    startProject("测试-trash-test", tmpDir);
    trashProject("测试-trash-test", tmpDir);
    expect(listProjects("trash", tmpDir)).toContain("测试-trash-test");

    restoreProject("测试-trash-test", tmpDir);
    expect(listProjects("drafting", tmpDir)).toContain("测试-trash-test");
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run src/modules/intel/integration.test.ts`
Expected: PASS.

**Step 3: Run full test suite**

Run: `npm test`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/modules/intel/integration.test.ts
git commit -m "test: add full pipeline flow integration test"
```

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | Dependencies | `package.json` |
| 2 | Pipeline types + dir init | `src/storage/pipeline-store.ts` |
| 3 | Intel save/list/archive | `src/storage/pipeline-store.ts` |
| 4 | Topic pool save/list/decay | `src/storage/pipeline-store.ts` |
| 5 | Project lifecycle | `src/storage/pipeline-store.ts` |
| 6 | Source config loader | `src/modules/intel/source-config.ts` |
| 7 | Collector interface + web search | `src/modules/intel/collectors/web-search.ts` |
| 8 | RSS collector | `src/modules/intel/collectors/rss.ts` |
| 9 | Trend collector | `src/modules/intel/collectors/trends.ts` |
| 10 | Competitor collector | `src/modules/intel/collectors/competitor.ts` |
| 11 | Intel engine orchestrator | `src/modules/intel/intel-engine.ts` |
| 12 | autocrew_intel tool | `src/tools/intel.ts` |
| 13 | autocrew_pipeline tool | `src/tools/pipeline-ops.ts` |
| 14 | CLI commands | `src/cli/commands/intel.ts` etc. |
| 15 | Data migration | `src/modules/migrate/legacy-migrate.ts` |
| 16 | Update init | `src/tools/init.ts` |
| 17 | Skills | `skills/intel-pull/` etc. |
| 18 | Integration test | `src/modules/intel/integration.test.ts` |
