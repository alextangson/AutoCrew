import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { migrateLegacyData } from "./legacy-migrate.js";
import {
  stagePath,
  listTopics,
  type ProjectMeta,
} from "../../storage/pipeline-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "autocrew-migrate-test-"),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function writeLegacyTopic(filename: string, data: Record<string, unknown>): Promise<void> {
  const dir = path.join(testDir, "topics");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data), "utf-8");
}

async function writeLegacyContent(
  id: string,
  meta: Record<string, unknown>,
  draftContent?: string,
): Promise<void> {
  const dir = path.join(testDir, "contents", `content-${id}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf-8");
  if (draftContent) {
    await fs.writeFile(path.join(dir, "draft.md"), draftContent, "utf-8");
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Legacy Migration", () => {
  it("migrates legacy topic JSON to markdown", async () => {
    await writeLegacyTopic("topic-1.json", {
      title: "AI写作工具评测",
      domain: "ai-content",
      score: { heat: 80, differentiation: 70, audienceFit: 90, overall: 80 },
      formats: ["video"],
      suggested_platforms: ["小红书"],
      created_at: "2024-01-15T00:00:00.000Z",
      intel_refs: [],
      angles: ["横向对比"],
      audience_resonance: "强烈兴趣",
      references: [],
    });

    const result = await migrateLegacyData(testDir);

    expect(result.topicsMigrated).toBe(1);
    expect(result.errors).toHaveLength(0);

    const topics = await listTopics(undefined, testDir);
    expect(topics.length).toBe(1);
    expect(topics[0].title).toBe("AI写作工具评测");
    expect(topics[0].score.overall).toBe(80);
    expect(topics[0].angles).toEqual(["横向对比"]);
  });

  it("migrates legacy content to correct pipeline stage", async () => {
    await writeLegacyContent("001", {
      title: "测试内容",
      domain: "tech",
      status: "drafting",
      format: "article",
      created_at: "2024-02-01T00:00:00.000Z",
    }, "# 测试内容\n\n草稿正文");

    await writeLegacyContent("002", {
      title: "已发布内容",
      domain: "tech",
      status: "published",
      format: "video",
      created_at: "2024-01-01T00:00:00.000Z",
    }, "# 已发布\n\n正文");

    await writeLegacyContent("003", {
      title: "审核通过",
      domain: "lifestyle",
      status: "approved",
      format: "article",
    });

    const result = await migrateLegacyData(testDir);

    expect(result.contentsMigrated).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Check drafting stage
    const draftingDir = stagePath("drafting", testDir);
    const draftingEntries = await fs.readdir(draftingDir);
    expect(draftingEntries.some((e) => e.includes("测试内容"))).toBe(true);

    // Check published stage
    const publishedDir = stagePath("published", testDir);
    const publishedEntries = await fs.readdir(publishedDir);
    expect(publishedEntries.some((e) => e.includes("已发布内容"))).toBe(true);

    // Check production stage
    const productionDir = stagePath("production", testDir);
    const productionEntries = await fs.readdir(productionDir);
    expect(productionEntries.some((e) => e.includes("审核通过"))).toBe(true);

    // Verify meta.yaml was created with correct data
    const draftProject = draftingEntries.find((e) => e.includes("测试内容"))!;
    const metaContent = await fs.readFile(
      path.join(draftingDir, draftProject, "meta.yaml"),
      "utf-8",
    );
    const meta = yaml.load(metaContent) as ProjectMeta;
    expect(meta.title).toBe("测试内容");
    expect(meta.domain).toBe("tech");
    expect(meta.history[0].stage).toBe("drafting");

    // Verify draft-v1.md was created from draft.md
    const draftV1 = await fs.readFile(
      path.join(draftingDir, draftProject, "draft-v1.md"),
      "utf-8",
    );
    expect(draftV1).toBe("# 测试内容\n\n草稿正文");
  });

  it("is idempotent — running twice does not duplicate", async () => {
    await writeLegacyTopic("topic-1.json", {
      title: "重复测试",
      domain: "test",
      score: { heat: 50, differentiation: 50, audienceFit: 50, overall: 50 },
      formats: [],
      created_at: "2024-01-01T00:00:00.000Z",
      angles: [],
      audience_resonance: "",
      references: [],
    });

    await writeLegacyContent("100", {
      title: "重复内容",
      domain: "test",
      status: "drafting",
      format: "article",
    });

    const first = await migrateLegacyData(testDir);
    expect(first.topicsMigrated).toBe(1);
    expect(first.contentsMigrated).toBe(1);

    const second = await migrateLegacyData(testDir);
    expect(second.topicsMigrated).toBe(0);
    expect(second.contentsMigrated).toBe(0);

    // Still only one of each
    const topics = await listTopics(undefined, testDir);
    expect(topics.length).toBe(1);
  });
});
