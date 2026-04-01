import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  saveTopic,
  listTopics,
  getTopic,
  saveContent,
  listContents,
  getContent,
  updateContent,
  addAsset,
  listAssets,
  removeAsset,
  listVersions,
  getVersion,
  revertToVersion,
  saveCoverReview,
  getCoverReview,
  approveCoverVariant,
  transitionStatus,
  getAllowedTransitions,
  createPlatformVariant,
  listSiblings,
  normalizeLegacyStatus,
  type CoverReview,
} from "../storage/local-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-store-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// --- Topics ---

describe("Topics", () => {
  it("saveTopic creates a topic with id and timestamp", async () => {
    const topic = await saveTopic({ title: "AI赚钱", description: "测试", tags: ["ai"] }, testDir);
    expect(topic.id).toBeTruthy();
    expect(topic.title).toBe("AI赚钱");
    expect(topic.createdAt).toBeTruthy();
  });

  it("listTopics returns saved topics", async () => {
    await saveTopic({ title: "T1", description: "d1", tags: [] }, testDir);
    await saveTopic({ title: "T2", description: "d2", tags: [] }, testDir);
    const topics = await listTopics(testDir);
    expect(topics).toHaveLength(2);
  });

  it("getTopic retrieves by id", async () => {
    const saved = await saveTopic({ title: "Find me", description: "d", tags: [] }, testDir);
    const found = await getTopic(saved.id, testDir);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Find me");
  });

  it("getTopic returns null for nonexistent id", async () => {
    const found = await getTopic("nonexistent", testDir);
    expect(found).toBeNull();
  });

  it("listTopics returns empty array when no topics", async () => {
    const topics = await listTopics(testDir);
    expect(topics).toEqual([]);
  });
});

// --- Content ---

describe("Content", () => {
  it("saveContent creates content with id and defaults", async () => {
    const content = await saveContent(
      { title: "Test", body: "Hello world", tags: ["test"], status: "draft_ready" },
      testDir,
    );
    expect(content.id).toBeTruthy();
    expect(content.status).toBe("draft_ready");
    expect(content.siblings).toEqual([]);
    expect(content.versions.length).toBeGreaterThanOrEqual(1);
  });

  it("listContents returns saved content", async () => {
    await saveContent({ title: "C1", body: "b1", tags: [], status: "draft_ready" }, testDir);
    await saveContent({ title: "C2", body: "b2", tags: [], status: "draft_ready" }, testDir);
    const items = await listContents(testDir);
    expect(items).toHaveLength(2);
  });

  it("getContent retrieves by id", async () => {
    const saved = await saveContent({ title: "Find", body: "me", tags: [], status: "draft_ready" }, testDir);
    const found = await getContent(saved.id, testDir);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Find");
  });

  it("getContent returns null for nonexistent", async () => {
    const found = await getContent("nope", testDir);
    expect(found).toBeNull();
  });

  it("updateContent merges fields", async () => {
    const saved = await saveContent({ title: "Original", body: "body", tags: [], status: "draft_ready" }, testDir);
    const updated = await updateContent(saved.id, { title: "Updated" }, testDir);
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated");
    expect(updated!.body).toBe("body");
  });

  it("updateContent creates a new version when body changes", async () => {
    const saved = await saveContent({ title: "V", body: "v1 body", tags: [], status: "draft_ready" }, testDir);
    await updateContent(saved.id, { body: "v2 body" }, testDir);
    const content = await getContent(saved.id, testDir);
    expect(content!.versions.length).toBeGreaterThanOrEqual(2);
  });

  it("updateContent returns null for nonexistent", async () => {
    const result = await updateContent("nope", { title: "x" }, testDir);
    expect(result).toBeNull();
  });
});

// --- Assets ---

describe("Assets", () => {
  it("addAsset adds to content assets list", async () => {
    const content = await saveContent({ title: "A", body: "b", tags: [], status: "draft_ready" }, testDir);
    const dummyFile = path.join(testDir, "test-image.jpg");
    await fs.writeFile(dummyFile, "fake image data");

    const result = await addAsset(
      content.id,
      { filename: "test-image.jpg", type: "cover", sourcePath: dummyFile },
      testDir,
    );
    expect(result.ok).toBe(true);

    const assets = await listAssets(content.id, testDir);
    expect(assets.length).toBeGreaterThanOrEqual(1);
    expect(assets.some((a) => a.type === "cover")).toBe(true);
  });

  it("listAssets returns empty for content with no assets", async () => {
    const content = await saveContent({ title: "A", body: "b", tags: [], status: "draft_ready" }, testDir);
    const assets = await listAssets(content.id, testDir);
    expect(assets).toEqual([]);
  });

  it("removeAsset removes from list", async () => {
    const content = await saveContent({ title: "A", body: "b", tags: [], status: "draft_ready" }, testDir);
    const dummyFile = path.join(testDir, "remove-me.png");
    await fs.writeFile(dummyFile, "data");
    await addAsset(content.id, { filename: "remove-me.png", type: "image", sourcePath: dummyFile }, testDir);

    const removed = await removeAsset(content.id, "remove-me.png", testDir);
    expect(removed).toBe(true);

    const assets = await listAssets(content.id, testDir);
    expect(assets.some((a) => a.filename === "remove-me.png")).toBe(false);
  });
});

// --- Versions ---

describe("Versions", () => {
  it("listVersions returns version history", async () => {
    const content = await saveContent({ title: "V", body: "v1", tags: [], status: "draft_ready" }, testDir);
    const versions = await listVersions(content.id, testDir);
    expect(versions.length).toBeGreaterThanOrEqual(1);
  });

  it("getVersion retrieves specific version body", async () => {
    const content = await saveContent({ title: "V", body: "original body", tags: [], status: "draft_ready" }, testDir);
    const body = await getVersion(content.id, 1, testDir);
    expect(body).toBe("original body");
  });

  it("revertToVersion restores old body", async () => {
    const content = await saveContent({ title: "V", body: "v1 body", tags: [], status: "draft_ready" }, testDir);
    await updateContent(content.id, { body: "v2 body" }, testDir);

    const reverted = await revertToVersion(content.id, 1, testDir);
    expect(reverted).not.toBeNull();
    expect(reverted!.body).toBe("v1 body");
  });
});

// --- Cover Review ---

describe("Cover Review", () => {
  it("saveCoverReview + getCoverReview round-trip", async () => {
    const content = await saveContent({ title: "C", body: "b", tags: [], status: "draft_ready" }, testDir);
    const review: CoverReview = {
      platform: "xhs",
      status: "review_pending",
      variants: [{ label: "a", style: "cinematic", imagePaths: { "3:4": "/tmp/a.png" } }],
    };
    await saveCoverReview(content.id, review, testDir);

    const loaded = await getCoverReview(content.id, testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.platform).toBe("xhs");
    expect(loaded!.variants).toHaveLength(1);
  });

  it("approveCoverVariant sets approvedLabel and status", async () => {
    const content = await saveContent({ title: "C", body: "b", tags: [], status: "draft_ready" }, testDir);
    const review: CoverReview = {
      platform: "xhs",
      status: "review_pending",
      variants: [
        { label: "a", imagePaths: {}, imagePath: "/tmp/a.png" },
        { label: "b", imagePaths: {}, imagePath: "/tmp/b.png" },
      ],
    };
    await saveCoverReview(content.id, review, testDir);

    const approved = await approveCoverVariant(content.id, "b", testDir);
    expect(approved).not.toBeNull();
    expect(approved!.approvedLabel).toBe("b");
    // approveCoverVariant sets review.status to "publish_ready"
    expect(approved!.status).toBe("publish_ready");
  });

  it("getCoverReview returns null when no review exists", async () => {
    const content = await saveContent({ title: "C", body: "b", tags: [], status: "draft_ready" }, testDir);
    const review = await getCoverReview(content.id, testDir);
    expect(review).toBeNull();
  });
});

// --- Status Transitions ---

describe("Status Transitions", () => {
  it("transitionStatus moves to allowed state", async () => {
    const content = await saveContent({ title: "T", body: "b", tags: [], status: "draft_ready" }, testDir);
    // draft_ready → reviewing is allowed
    const result = await transitionStatus(content.id, "reviewing", undefined, testDir);
    expect(result.ok).toBe(true);
    const updated = await getContent(content.id, testDir);
    expect(updated!.status).toBe("reviewing");
  });

  it("transitionStatus rejects invalid transition", async () => {
    const content = await saveContent({ title: "T", body: "b", tags: [], status: "draft_ready" }, testDir);
    // draft_ready → published is not allowed directly
    const result = await transitionStatus(content.id, "published", undefined, testDir);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("getAllowedTransitions returns valid next states", () => {
    const allowed = getAllowedTransitions("draft_ready");
    expect(allowed).toContain("reviewing");
    expect(allowed.length).toBeGreaterThan(0);
  });

  it("normalizeLegacyStatus maps old status names", () => {
    expect(normalizeLegacyStatus("draft")).toBe("draft_ready");
    expect(normalizeLegacyStatus("review")).toBe("reviewing");
    expect(normalizeLegacyStatus("approved")).toBe("approved");
  });
});

// --- Platform Variants + Siblings ---

describe("Platform Variants & Siblings", () => {
  it("createPlatformVariant creates a sibling content from topic", async () => {
    // createPlatformVariant takes topicId, not contentId
    const topic = await saveTopic({ title: "Original", description: "desc", tags: [] }, testDir);
    const result = await createPlatformVariant(topic.id, "douyin", undefined, testDir);
    expect(result.ok).toBe(true);
    expect(result.content).toBeDefined();
    expect(result.content!.platform).toBe("douyin");
  });

  it("siblings are linked when multiple variants exist", async () => {
    const topic = await saveTopic({ title: "O", description: "d", tags: [] }, testDir);
    // Create first variant
    const r1 = await createPlatformVariant(topic.id, "xhs", undefined, testDir);
    expect(r1.ok).toBe(true);
    // Create second variant
    const r2 = await createPlatformVariant(topic.id, "douyin", undefined, testDir);
    expect(r2.ok).toBe(true);

    // Both should be siblings of each other
    const siblings1 = await listSiblings(r1.content!.id, testDir);
    expect(siblings1.some((s) => s.id === r2.content!.id)).toBe(true);

    const siblings2 = await listSiblings(r2.content!.id, testDir);
    expect(siblings2.some((s) => s.id === r1.content!.id)).toBe(true);
  });

  it("createPlatformVariant returns error for nonexistent topic", async () => {
    const result = await createPlatformVariant("nope", "douyin", undefined, testDir);
    expect(result.ok).toBe(false);
  });
});
