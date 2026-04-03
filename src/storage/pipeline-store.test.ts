import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PIPELINE_STAGES,
  initPipeline,
  pipelinePath,
  stagePath,
  slugify,
  saveIntel,
  listIntel,
  archiveExpiredIntel,
  intelToMarkdown,
  parseIntelFile,
  type IntelItem,
} from "../storage/pipeline-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "autocrew-pipeline-test-"),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ─── Pipeline Init ──────────────────────────────────────────────────────────

describe("Pipeline Init", () => {
  it("pipelinePath returns correct path", () => {
    expect(pipelinePath(testDir)).toBe(path.join(testDir, "pipeline"));
  });

  it("stagePath returns correct path", () => {
    expect(stagePath("intel", testDir)).toBe(
      path.join(testDir, "pipeline", "intel"),
    );
  });

  it("initPipeline creates all stage directories", async () => {
    await initPipeline(testDir);
    for (const stage of PIPELINE_STAGES) {
      const stat = await fs.stat(stagePath(stage, testDir));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it("initPipeline creates intel subdirectories", async () => {
    await initPipeline(testDir);
    const intelDir = stagePath("intel", testDir);
    const sources = await fs.stat(path.join(intelDir, "_sources"));
    const archive = await fs.stat(path.join(intelDir, "_archive"));
    expect(sources.isDirectory()).toBe(true);
    expect(archive.isDirectory()).toBe(true);
  });

  it("initPipeline is idempotent", async () => {
    await initPipeline(testDir);
    await initPipeline(testDir);
    for (const stage of PIPELINE_STAGES) {
      const stat = await fs.stat(stagePath(stage, testDir));
      expect(stat.isDirectory()).toBe(true);
    }
  });
});

// ─── Slugify ─────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("handles English text", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });

  it("handles Chinese text", () => {
    expect(slugify("AI内容创作趋势")).toBe("ai内容创作趋势");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeIntel(overrides: Partial<IntelItem> = {}): IntelItem {
  return {
    title: "AI内容创作新趋势",
    domain: "ai-content",
    source: "web_search",
    collectedAt: new Date().toISOString(),
    relevance: 85,
    tags: ["AI", "内容创作"],
    expiresAfter: 7,
    summary: "AI正在改变内容创作流程",
    keyPoints: ["效率提升3倍", "质量可控"],
    topicPotential: "可做系列教程选题",
    ...overrides,
  };
}

// ─── Intel Storage ──────────────────────────────────────────────────────────

describe("Intel Storage", () => {
  it("saves intel as markdown with correct frontmatter", async () => {
    const item = makeIntel();
    const filePath = await saveIntel(item, testDir);
    expect(filePath).toContain("ai-content");
    expect(filePath.endsWith(".md")).toBe(true);

    const content = await fs.readFile(filePath, "utf-8");
    const parsed = parseIntelFile(content);
    expect(parsed.title).toBe(item.title);
    expect(parsed.domain).toBe(item.domain);
    expect(parsed.source).toBe(item.source);
    expect(parsed.relevance).toBe(item.relevance);
    expect(parsed.tags).toEqual(item.tags);
    expect(parsed.keyPoints).toEqual(item.keyPoints);
    expect(parsed.summary).toBe(item.summary);
  });

  it("lists intel by domain", async () => {
    await saveIntel(makeIntel({ domain: "ai-content" }), testDir);
    await saveIntel(
      makeIntel({ title: "电商新玩法", domain: "ecommerce" }),
      testDir,
    );

    const all = await listIntel(undefined, testDir);
    expect(all.length).toBe(2);

    const aiOnly = await listIntel("ai-content", testDir);
    expect(aiOnly.length).toBe(1);
    expect(aiOnly[0].domain).toBe("ai-content");
  });

  it("deduplicates by title slug", async () => {
    const item = makeIntel();
    await saveIntel(item, testDir);
    await saveIntel({ ...item, relevance: 99 }, testDir);

    const items = await listIntel(undefined, testDir);
    expect(items.length).toBe(1);
    expect(items[0].relevance).toBe(99);
  });

  it("archives expired intel", async () => {
    const expired = makeIntel({
      collectedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      expiresAfter: 7,
    });
    const fresh = makeIntel({
      title: "新鲜资讯",
      collectedAt: new Date().toISOString(),
      expiresAfter: 7,
    });

    await saveIntel(expired, testDir);
    await saveIntel(fresh, testDir);

    const result = await archiveExpiredIntel(testDir);
    expect(result.archived).toBe(1);

    const remaining = await listIntel(undefined, testDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0].title).toBe("新鲜资讯");
  });

  it("roundtrips intel through markdown", () => {
    const item = makeIntel();
    const md = intelToMarkdown(item);
    const parsed = parseIntelFile(md);
    expect(parsed.title).toBe(item.title);
    expect(parsed.keyPoints).toEqual(item.keyPoints);
    expect(parsed.topicPotential).toBe(item.topicPotential);
  });
});
