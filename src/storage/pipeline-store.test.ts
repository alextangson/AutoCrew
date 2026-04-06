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
  saveTopic,
  listTopics,
  decayTopicScores,
  topicToMarkdown,
  parseTopicFile,
  startProject,
  advanceProject,
  addDraftVersion,
  trashProject,
  restoreProject,
  getProjectMeta,
  listProjects,
  saveWikiPage,
  getWikiPage,
  listWikiPages,
  regenerateWikiIndex,
  appendWikiLog,
  type IntelItem,
  type TopicCandidate,
  type WikiPage,
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

function makeTopic(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    title: "AI写作工具评测",
    domain: "ai-content",
    score: { heat: 80, differentiation: 70, audienceFit: 90, overall: 80 },
    formats: ["video", "article"],
    suggestedPlatforms: ["小红书", "B站"],
    createdAt: new Date().toISOString(),
    intelRefs: ["2024-01-15-ai-content-trend.md"],
    angles: ["横向对比", "实操演示"],
    audienceResonance: "目标用户对AI工具有强烈兴趣",
    references: ["https://example.com/ai-tools"],
    ...overrides,
  };
}

// ─── Task 2: Pipeline Init ──────────────────────────────────────────────────

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

  it("creates wiki directory", async () => {
    await initPipeline(testDir);
    const stat = await fs.stat(stagePath("wiki", testDir));
    expect(stat.isDirectory()).toBe(true);
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

// ─── Task 3: Intel Storage ──────────────────────────────────────────────────

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

// ─── Task 4: Topic Pool ─────────────────────────────────────────────────────

describe("Topic Pool", () => {
  it("saves topic with frontmatter scores", async () => {
    const topic = makeTopic();
    const filePath = await saveTopic(topic, testDir);
    expect(filePath.endsWith(".md")).toBe(true);

    const content = await fs.readFile(filePath, "utf-8");
    const parsed = parseTopicFile(content);
    expect(parsed.title).toBe(topic.title);
    expect(parsed.score.overall).toBe(80);
    expect(parsed.score.heat).toBe(80);
    expect(parsed.angles).toEqual(topic.angles);
  });

  it("lists topics sorted by overall score desc", async () => {
    await saveTopic(
      makeTopic({ title: "低分选题", score: { heat: 30, differentiation: 30, audienceFit: 30, overall: 30 } }),
      testDir,
    );
    await saveTopic(
      makeTopic({ title: "高分选题", score: { heat: 90, differentiation: 90, audienceFit: 90, overall: 90 } }),
      testDir,
    );

    const topics = await listTopics(undefined, testDir);
    expect(topics.length).toBe(2);
    expect(topics[0].title).toBe("高分选题");
    expect(topics[1].title).toBe("低分选题");
  });

  it("decays and trashes old low-score topics", async () => {
    // 20 days old, score 30 → decay = (20-14)*2 = 12 → 18 → trash
    const old = makeTopic({
      title: "旧选题",
      createdAt: new Date(Date.now() - 20 * 86400000).toISOString(),
      score: { heat: 30, differentiation: 30, audienceFit: 30, overall: 30 },
    });
    // Fresh topic, should not decay
    const fresh = makeTopic({
      title: "新选题",
      createdAt: new Date().toISOString(),
      score: { heat: 80, differentiation: 80, audienceFit: 80, overall: 80 },
    });

    await saveTopic(old, testDir);
    await saveTopic(fresh, testDir);

    const result = await decayTopicScores(testDir);
    expect(result.decayed).toBe(1);
    expect(result.trashed).toBe(1);

    const remaining = await listTopics(undefined, testDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0].title).toBe("新选题");
  });

  it("roundtrips topic through markdown", () => {
    const topic = makeTopic();
    const md = topicToMarkdown(topic);
    const parsed = parseTopicFile(md);
    expect(parsed.title).toBe(topic.title);
    expect(parsed.score).toEqual(topic.score);
    expect(parsed.audienceResonance).toBe(topic.audienceResonance);
  });
});

// ─── Task 5: Project Lifecycle ──────────────────────────────────────────────

describe("Project Lifecycle", () => {
  it("starts project from topic", async () => {
    const topic = makeTopic({ title: "测试项目选题" });
    await saveTopic(topic, testDir);

    const projectDir = await startProject("测试项目选题", testDir);
    expect(projectDir).toContain("drafting");

    // Topic file should be removed
    const topics = await listTopics(undefined, testDir);
    expect(topics.length).toBe(0);

    // Project dir should contain meta.yaml, draft.md (live), references/.
    // No draft-v*.md exists yet — snapshots are created only when revisions replace draft.md.
    const files = await fs.readdir(projectDir);
    expect(files).toContain("meta.yaml");
    expect(files).toContain("draft.md");
    expect(files).toContain("references");
    expect(files.filter((f) => f.startsWith("draft-v"))).toHaveLength(0);
  });

  it("advances project from drafting to production", async () => {
    await saveTopic(makeTopic({ title: "推进测试" }), testDir);
    await startProject("推进测试", testDir);

    const projectName = slugify("推进测试");
    const newDir = await advanceProject(projectName, testDir);
    expect(newDir).toContain("production");

    const meta = await getProjectMeta(projectName, testDir);
    expect(meta).not.toBeNull();
    expect(meta!.history.length).toBe(2);
    expect(meta!.history[1].stage).toBe("production");
  });

  it("adds draft versions", async () => {
    await saveTopic(makeTopic({ title: "版本测试" }), testDir);
    await startProject("版本测试", testDir);

    const projectName = slugify("版本测试");
    const projectDir = path.join(stagePath("drafting", testDir), projectName);

    // Capture the initial live content before revising
    const fsp = await import("node:fs/promises");
    const originalContent = await fsp.readFile(
      path.join(projectDir, "draft.md"),
      "utf-8",
    );

    await addDraftVersion(projectName, "# V2 内容", "second draft", testDir);

    const meta = await getProjectMeta(projectName, testDir);
    // One snapshot should have been created (archiving the original)
    expect(meta!.versions.length).toBe(1);
    expect(meta!.versions[0].file).toBe("draft-v1.md");
    expect(meta!.versions[0].note).toBe("second draft");
    expect(meta!.current).toBe("draft.md");

    // draft.md is now the new content
    const liveContent = await fsp.readFile(
      path.join(projectDir, "draft.md"),
      "utf-8",
    );
    expect(liveContent).toBe("# V2 内容");

    // draft-v1.md holds the frozen original
    const archivedContent = await fsp.readFile(
      path.join(projectDir, "draft-v1.md"),
      "utf-8",
    );
    expect(archivedContent).toBe(originalContent);
  });

  it("trashes and restores project", async () => {
    await saveTopic(makeTopic({ title: "回收测试" }), testDir);
    await startProject("回收测试", testDir);

    const projectName = slugify("回收测试");
    await trashProject(projectName, testDir);

    // Should be in trash
    const trashProjects = await listProjects("trash", testDir);
    expect(trashProjects).toContain(projectName);

    // Restore
    const restoredDir = await restoreProject(projectName, testDir);
    expect(restoredDir).toContain("drafting");

    const meta = await getProjectMeta(projectName, testDir);
    expect(meta!.history.filter((h) => h.stage === "trash").length).toBe(1);
    expect(meta!.history.at(-1)!.stage).toBe("drafting");
  });

  it("listProjects returns project names in stage", async () => {
    await saveTopic(makeTopic({ title: "项目A" }), testDir);
    await startProject("项目a", testDir);

    const projects = await listProjects("drafting", testDir);
    expect(projects.length).toBeGreaterThan(0);
  });
});

// ─── Wiki Storage ──────────────────────────────────────────────────────────

function makeWikiPage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    type: "entity",
    title: "Claude AI",
    aliases: ["Claude", "Anthropic Claude"],
    related: ["anthropic", "llm"],
    sources: ["intel/2024-01-15-claude.md"],
    created: "2026-04-05T00:00:00.000Z",
    updated: "2026-04-05T00:00:00.000Z",
    body: "Claude is an AI assistant made by Anthropic.",
    ...overrides,
  };
}

describe("Wiki Storage", () => {
  it("saves and reads a wiki page", async () => {
    const page = makeWikiPage();
    const filePath = await saveWikiPage(page, testDir);
    expect(filePath).toContain("wiki");
    expect(filePath.endsWith(".md")).toBe(true);

    const slug = "claude-ai";
    const loaded = await getWikiPage(slug, testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe(page.title);
    expect(loaded!.type).toBe(page.type);
    expect(loaded!.aliases).toEqual(page.aliases);
    expect(loaded!.related).toEqual(page.related);
    expect(loaded!.sources).toEqual(page.sources);
    expect(loaded!.body).toBe(page.body);
  });

  it("lists all wiki pages", async () => {
    await saveWikiPage(makeWikiPage({ title: "Claude AI" }), testDir);
    await saveWikiPage(
      makeWikiPage({ title: "GPT-4", type: "comparison" }),
      testDir,
    );

    const pages = await listWikiPages(testDir);
    expect(pages.length).toBe(2);
  });

  it("generates index.md grouped by type", async () => {
    await saveWikiPage(makeWikiPage({ title: "Claude AI", type: "entity" }), testDir);
    await saveWikiPage(makeWikiPage({ title: "LLM Basics", type: "concept" }), testDir);
    await saveWikiPage(makeWikiPage({ title: "Claude vs GPT", type: "comparison" }), testDir);

    await regenerateWikiIndex(testDir);

    const indexPath = path.join(stagePath("wiki", testDir), "index.md");
    const content = await fs.readFile(indexPath, "utf-8");
    expect(content).toContain("# Wiki Index");
    expect(content).toContain("## comparison");
    expect(content).toContain("## concept");
    expect(content).toContain("## entity");
    expect(content).toContain("Claude AI");
    expect(content).toContain("LLM Basics");
    expect(content).toContain("Claude vs GPT");
  });

  it("appends to log.md", async () => {
    await appendWikiLog("create", "Created page: Claude AI", testDir);
    await appendWikiLog("update", "Updated page: Claude AI", testDir);

    const logPath = path.join(stagePath("wiki", testDir), "log.md");
    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("[create]");
    expect(lines[1]).toContain("[update]");
  });
});
