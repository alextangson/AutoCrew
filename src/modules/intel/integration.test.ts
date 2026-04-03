import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  initPipeline,
  saveIntel,
  listIntel,
  saveTopic,
  listTopics,
  startProject,
  addDraftVersion,
  advanceProject,
  getProjectMeta,
  trashProject,
  restoreProject,
  listProjects,
  slugify,
  stagePath,
  type IntelItem,
  type TopicCandidate,
} from "../../storage/pipeline-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "autocrew-integration-test-"),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

// ─── Full Pipeline Flow ─────────────────────────────────────────────────────

describe("Pipeline Integration — full flow", () => {
  it("walks intel → topic → project → production → published", async () => {
    // 1. Init pipeline
    await initPipeline(testDir);
    for (const stage of ["intel", "topics", "drafting", "production", "published", "trash"] as const) {
      const stat = await fs.stat(stagePath(stage, testDir));
      expect(stat.isDirectory()).toBe(true);
    }

    // 2. Save intel → list confirms it's there
    const intel = makeIntel();
    await saveIntel(intel, testDir);
    const intelItems = await listIntel(undefined, testDir);
    expect(intelItems.length).toBe(1);
    expect(intelItems[0].title).toBe(intel.title);

    // 3. Save topic → list confirms sorted by score
    const topicHigh = makeTopic({
      title: "高分选题",
      score: { heat: 95, differentiation: 90, audienceFit: 95, overall: 95 },
    });
    const topicLow = makeTopic({
      title: "低分选题",
      score: { heat: 40, differentiation: 30, audienceFit: 50, overall: 40 },
    });
    await saveTopic(topicLow, testDir);
    await saveTopic(topicHigh, testDir);

    const topics = await listTopics(undefined, testDir);
    expect(topics.length).toBe(2);
    expect(topics[0].title).toBe("高分选题");
    expect(topics[1].title).toBe("低分选题");

    // 4. Start project from high-score topic → topic consumed, project dir created
    const projectDir = await startProject("高分选题", testDir);
    expect(projectDir).toContain("drafting");

    const remainingTopics = await listTopics(undefined, testDir);
    expect(remainingTopics.length).toBe(1);
    expect(remainingTopics[0].title).toBe("低分选题");

    const files = await fs.readdir(projectDir);
    expect(files).toContain("meta.yaml");
    expect(files).toContain("draft-v1.md");
    expect(files).toContain("draft.md");

    const projectName = slugify("高分选题");

    // 5. Add draft version → meta.yaml updated with v2
    await addDraftVersion(
      projectName,
      "# 高分选题\n\n第二版内容",
      "improved draft",
      testDir,
    );

    let meta = await getProjectMeta(projectName, testDir);
    expect(meta).not.toBeNull();
    expect(meta!.versions.length).toBe(2);
    expect(meta!.current).toBe("draft-v2.md");
    expect(meta!.versions[1].note).toBe("improved draft");

    // 6. Advance: drafting → production → published
    await advanceProject(projectName, testDir);
    meta = await getProjectMeta(projectName, testDir);
    expect(meta!.history.at(-1)!.stage).toBe("production");

    await advanceProject(projectName, testDir);
    meta = await getProjectMeta(projectName, testDir);
    expect(meta!.history.at(-1)!.stage).toBe("published");

    // 7. Verify history has all stage entries
    expect(meta!.history.length).toBe(3);
    expect(meta!.history[0].stage).toBe("drafting");
    expect(meta!.history[1].stage).toBe("production");
    expect(meta!.history[2].stage).toBe("published");
  });
});

// ─── Trash & Restore ────────────────────────────────────────────────────────

describe("Pipeline Integration — trash and restore", () => {
  it("trashes and restores a project preserving state", async () => {
    await initPipeline(testDir);

    // Set up a project in drafting
    await saveTopic(makeTopic({ title: "回收还原测试" }), testDir);
    await startProject("回收还原测试", testDir);
    const projectName = slugify("回收还原测试");

    // Add a draft version so there's real state
    await addDraftVersion(
      projectName,
      "# 重要内容\n\n不能丢失",
      "v2",
      testDir,
    );

    // Trash it
    await trashProject(projectName, testDir);

    const trashList = await listProjects("trash", testDir);
    expect(trashList).toContain(projectName);

    const draftingList = await listProjects("drafting", testDir);
    expect(draftingList).not.toContain(projectName);

    // Restore it
    const restoredDir = await restoreProject(projectName, testDir);
    expect(restoredDir).toContain("drafting");

    // Verify state is preserved
    const meta = await getProjectMeta(projectName, testDir);
    expect(meta).not.toBeNull();
    expect(meta!.versions.length).toBe(2);
    expect(meta!.current).toBe("draft-v2.md");
    expect(meta!.title).toBe("回收还原测试");

    // History should show: drafting → trash → drafting
    expect(meta!.history.length).toBe(3);
    expect(meta!.history[0].stage).toBe("drafting");
    expect(meta!.history[1].stage).toBe("trash");
    expect(meta!.history[2].stage).toBe("drafting");

    // Content should be intact
    const draftContent = await fs.readFile(
      path.join(restoredDir, "draft.md"),
      "utf-8",
    );
    expect(draftContent).toBe("# 重要内容\n\n不能丢失");
  });
});
