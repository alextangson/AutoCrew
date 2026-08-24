import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  saveTopic,
  updateTopic,
  listTopics,
  getTopic,
  saveContent,
  listContents,
  getContent,
  updateContent,
  addAsset,
  upsertAsset,
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
  describeAllowedTransitions,
  stageBlockReason,
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
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

  it("updateTopic enriches a topic without changing id/createdAt", async () => {
    const saved = await saveTopic({ title: "Raw title", description: "d", tags: [] }, testDir);
    const updated = await updateTopic(saved.id, {
      title: "中文可写选题",
      originalTitle: "Raw title",
      score: 82,
      angles: ["角度一"],
    }, testDir);
    expect(updated).toMatchObject({ id: saved.id, createdAt: saved.createdAt, title: "中文可写选题", score: 82 });
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
    const updated = await updateContent(saved.id, { title: "Updated", _versionNote: "优化标题" }, testDir);
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated");
    expect(updated!.body).toBe("body");
    expect(updated!.versions).toHaveLength(2);
    expect(updated!.versions[1]).toMatchObject({ title: "Updated", body: "body", note: "优化标题" });
  });

  it("updateContent creates a new version when body changes", async () => {
    const saved = await saveContent({ title: "V", body: "v1 body", tags: [], status: "draft_ready" }, testDir);
    await updateContent(saved.id, { body: "v2 body" }, testDir);
    const content = await getContent(saved.id, testDir);
    expect(content!.versions.length).toBeGreaterThanOrEqual(2);
    expect(content!.versions[1].title).toBe("V");
  });

  it("updateContent returns null for nonexistent", async () => {
    const result = await updateContent("nope", { title: "x" }, testDir);
    expect(result).toBeNull();
  });
});

// --- 并发与失败可见性（codex 2026-07-27：非原子读改写互相覆盖 + 吞异常返回 null） ---

describe("Content write safety", () => {
  it("updateContent returns null for a well-formed id that does not exist", async () => {
    const result = await updateContent("content-nope", { title: "x" }, testDir);
    expect(result).toBeNull();
  });

  it("updateContent throws on corrupt meta.json instead of returning null", async () => {
    const saved = await saveContent({ title: "C", body: "b", tags: [], status: "draft_ready" }, testDir);
    await fs.writeFile(path.join(testDir, "contents", saved.id, "meta.json"), "not json{", "utf-8");
    await expect(updateContent(saved.id, { title: "x" }, testDir)).rejects.toThrow();
  });

  it("updateContent surfaces write failures instead of returning null", async () => {
    const saved = await saveContent({ title: "C", body: "b", tags: [], status: "draft_ready" }, testDir);
    const projDir = path.join(testDir, "contents", saved.id);
    await fs.chmod(projDir, 0o555);
    try {
      // digest-only 更新:不触发版本快照,首个写盘动作就落在只读目录里
      await expect(updateContent(saved.id, { digest: "钩子" }, testDir)).rejects.toThrow();
    } finally {
      await fs.chmod(projDir, 0o755);
    }
  });

  it("concurrent updateContent calls do not overwrite each other's fields", async () => {
    const saved = await saveContent({ title: "原稿", body: "b", tags: [], status: "draft_ready" }, testDir);
    await Promise.all([
      updateContent(saved.id, { digest: "摘要钩子" }, testDir),
      updateContent(saved.id, { title: "新标题" }, testDir),
    ]);
    const final = await getContent(saved.id, testDir);
    expect(final!.digest).toBe("摘要钩子");
    expect(final!.title).toBe("新标题");
  });

  it("concurrent updateContent and addAsset both land", async () => {
    const saved = await saveContent({ title: "C", body: "b", tags: [], status: "draft_ready" }, testDir);
    const [updated, assetRes] = await Promise.all([
      updateContent(saved.id, { digest: "并发摘要" }, testDir),
      addAsset(saved.id, { filename: "cover.png", type: "cover" }, testDir),
    ]);
    expect(updated).not.toBeNull();
    expect(assetRes.ok).toBe(true);
    const final = await getContent(saved.id, testDir);
    expect(final!.digest).toBe("并发摘要");
    expect(final!.assets.map((a) => a.filename)).toContain("cover.png");
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

// --- 挂接落盘 = 硬链接（GB 级 A-roll 不再双份占盘） ---

describe("addAsset 硬链接语义", () => {
  async function seedContentAndSource(name: string, bytes: string) {
    const content = await saveContent({ title: "A", body: "b", tags: [], status: "draft_ready" }, testDir);
    const src = path.join(testDir, name);
    await fs.writeFile(src, bytes);
    return { content, src, dest: path.join(testDir, "contents", content.id, "assets", name) };
  }

  it("同卷落盘是硬链接：两侧同 inode，字节只存一份", async () => {
    const { content, src, dest } = await seedContentAndSource("aroll.mp4", "gigabytes-of-aroll");
    const r = await addAsset(content.id, { filename: "aroll.mp4", type: "video", sourcePath: src }, testDir);
    expect(r.ok).toBe(true);

    const [s, d] = [await fs.stat(src), await fs.stat(dest)];
    expect(d.ino).toBe(s.ino);
    expect(d.nlink).toBe(2);
  });

  it("link 失败（如跨卷 EXDEV）退回复制，挂接照常成功", async () => {
    const { content, src, dest } = await seedContentAndSource("cross.mp4", "cross-volume-bytes");
    const spy = vi
      .spyOn(fs, "link")
      .mockRejectedValueOnce(Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" }));
    try {
      const r = await addAsset(content.id, { filename: "cross.mp4", type: "video", sourcePath: src }, testDir);
      expect(r.ok).toBe(true);
      expect(spy).toHaveBeenCalled();
      expect(await fs.readFile(dest, "utf-8")).toBe("cross-volume-bytes");
      expect((await fs.stat(dest)).ino).not.toBe((await fs.stat(src)).ino);
    } finally {
      spy.mockRestore();
    }
  });

  it("removeAsset 只断稿件那条链接：源文件与数据原样还在", async () => {
    const { content, src, dest } = await seedContentAndSource("keep.mp4", "shared-bytes");
    await addAsset(content.id, { filename: "keep.mp4", type: "video", sourcePath: src }, testDir);

    expect(await removeAsset(content.id, "keep.mp4", testDir)).toBe(true);
    await expect(fs.access(dest)).rejects.toThrow();
    expect(await fs.readFile(src, "utf-8")).toBe("shared-bytes");
    expect((await fs.stat(src)).nlink).toBe(1);
  });

  it("upsertAsset 同名覆盖先断链再拷：不写穿硬链接另一侧的共享字节", async () => {
    const { content, src, dest } = await seedContentAndSource("final-v1.mp4", "library-original");
    await addAsset(content.id, { filename: "final-v1.mp4", type: "video", sourcePath: src }, testDir);

    const rerender = path.join(testDir, "rerender.mp4");
    await fs.writeFile(rerender, "rerendered-bytes");
    const r = await upsertAsset(content.id, { filename: "final-v1.mp4", type: "video", sourcePath: rerender }, testDir);
    expect(r.ok).toBe(true);

    expect(await fs.readFile(dest, "utf-8")).toBe("rerendered-bytes");
    expect(await fs.readFile(src, "utf-8")).toBe("library-original");
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

  it("阶段制迁移表：approved 多一条剪辑出口，editing/cover_pending 各自成边（spec §1.1）", () => {
    expect(getAllowedTransitions("approved")).toEqual(["publish_ready", "reviewing", "editing"]);
    expect(getAllowedTransitions("editing")).toEqual(["cover_pending", "approved"]);
    // cover_pending 的出口从 approved 改为 editing——回的是剪辑台，不是文案页
    expect(getAllowedTransitions("cover_pending")).toEqual(["publish_ready", "editing"]);
  });

  it("normalizeLegacyStatus maps old status names", () => {
    expect(normalizeLegacyStatus("draft")).toBe("draft_ready");
    expect(normalizeLegacyStatus("review")).toBe("reviewing");
    expect(normalizeLegacyStatus("approved")).toBe("approved");
  });
});

// --- 阶段门在写锁内（阶段制 spec §1.2）---

describe("阶段门 · 收口通道", () => {
  const video = async () =>
    saveContent({ title: "口播稿", body: "b", tags: [], platform: "douyin", status: "approved" }, testDir);
  const text = async () =>
    saveContent({ title: "长文", body: "b", tags: [], platform: "wechat_mp", status: "approved" }, testDir);

  it("视频稿 approved 直通 publish_ready 被门拦下,状态一个字没动", async () => {
    const c = await video();
    const r = await transitionStatus(c.id, "publish_ready", undefined, testDir);
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.error).toContain("推进到剪辑");
    expect((await getContent(c.id, testDir))!.status).toBe("approved");
  });

  it("force 越得过状态图形状,越不过阶段门", async () => {
    const c = await video();
    const r = await transitionStatus(c.id, "publish_ready", { force: true }, testDir);
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect((await getContent(c.id, testDir))!.status).toBe("approved");
  });

  it("文字稿照旧 approved → publish_ready 直通", async () => {
    const c = await text();
    expect((await transitionStatus(c.id, "publish_ready", undefined, testDir)).ok).toBe(true);
  });

  it("文字稿进不了剪辑阶段", async () => {
    const c = await text();
    const r = await transitionStatus(c.id, "editing", undefined, testDir);
    expect(r.blocked).toBe(true);
    expect(r.error).toContain("只属于视频平台");
  });

  it("editing → cover_pending 只认 videoDone：videoReadyAt 有值也拦", async () => {
    const c = await video();
    await transitionStatus(c.id, "editing", undefined, testDir);
    // 首次达成的指标戳在，但这一版成片没审过——不许放行过时成片
    await updateContent(c.id, { videoReadyAt: new Date().toISOString() }, testDir);
    expect((await transitionStatus(c.id, "cover_pending", undefined, testDir)).blocked).toBe(true);

    await updateContent(c.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } }, testDir);
    expect((await transitionStatus(c.id, "cover_pending", undefined, testDir)).ok).toBe(true);
  });

  it("cover_pending → publish_ready 要封面已批准", async () => {
    const c = await video();
    await updateContent(c.id, { videoDone: { renderedRevision: 1, at: "x" } }, testDir);
    await transitionStatus(c.id, "editing", undefined, testDir);
    await transitionStatus(c.id, "cover_pending", undefined, testDir);
    expect((await transitionStatus(c.id, "publish_ready", undefined, testDir)).blocked).toBe(true);

    await saveCoverReview(
      c.id,
      { platform: "douyin", status: "review_pending", variants: [{ label: "a", imagePaths: { "3:4": "/tmp/a.png" } }] },
      testDir,
    );
    await approveCoverVariant(c.id, "a", testDir);
    expect((await transitionStatus(c.id, "publish_ready", undefined, testDir)).ok).toBe(true);
  });

  it("saveContent 也过门：公众号稿建不进剪辑阶段", async () => {
    await expect(
      saveContent({ title: "x", body: "b", tags: [], platform: "wechat_mp", status: "editing" }, testDir),
    ).rejects.toThrow(/剪辑阶段只属于视频平台/);
  });

  it("expectedStatus 对不上就拒绝、不覆盖（旧标签页 / 双击）", async () => {
    const c = await video();
    const first = await transitionStatus(c.id, "editing", { expectedStatus: "approved" }, testDir);
    expect(first.ok).toBe(true);
    // 第二次带的还是那一屏看到的 approved——盘上已经是 editing 了
    const second = await transitionStatus(c.id, "editing", { expectedStatus: "approved" }, testDir);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("刷新");
    expect((await getContent(c.id, testDir))!.status).toBe("editing");
  });

  it("并发推进只成一次：校验与写入在同一把锁里（无 CAS 时两边都会读到旧状态）", async () => {
    const c = await video();
    const [a, b] = await Promise.all([
      transitionStatus(c.id, "editing", undefined, testDir),
      transitionStatus(c.id, "reviewing", undefined, testDir),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const winner = a.ok ? "editing" : "reviewing";
    expect((await getContent(c.id, testDir))!.status).toBe(winner);
  });

  it("stageBlockReason 是不写盘的同一判定", async () => {
    const c = await video();
    const content = (await getContent(c.id, testDir))!;
    expect(await stageBlockReason(content, "publish_ready", testDir)).toContain("推进到剪辑");
    expect(await stageBlockReason(content, "editing", testDir)).toBeNull();
    expect((await getContent(c.id, testDir))!.status).toBe("approved"); // 预判不落盘
  });

  it("describeAllowedTransitions 把被拦的那一条标出原因（推进下拉灰显）", async () => {
    const c = await video();
    const list = await describeAllowedTransitions((await getContent(c.id, testDir))!, testDir);
    expect(list.find((t) => t.status === "editing")?.blockedReason).toBeUndefined();
    expect(list.find((t) => t.status === "publish_ready")?.blockedReason).toContain("推进到剪辑");
  });
});

// --- Legacy status normalization on read (S2.7 pre-dogfood hardening) ---

/** Write a meta.json straight to disk with an arbitrary (possibly legacy) status. */
async function seedLegacyContent(id: string, status: string): Promise<void> {
  const projDir = path.join(testDir, "contents", id);
  await fs.mkdir(projDir, { recursive: true });
  const meta = {
    id,
    title: `legacy ${status}`,
    body: "body",
    status,
    tags: [],
    siblings: [],
    hashtags: [],
    publishedAt: null,
    publishUrl: null,
    performanceData: {},
    assets: [],
    versions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await fs.writeFile(path.join(projDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
}

describe("Legacy status normalization on read", () => {
  it("listContents normalizes legacy 'draft'/'review' to new status names", async () => {
    await seedLegacyContent("legacy-draft", "draft");
    await seedLegacyContent("legacy-review", "review");

    const contents = await listContents(testDir);
    const byId = Object.fromEntries(contents.map((c) => [c.id, c]));

    expect(byId["legacy-draft"].status).toBe("draft_ready");
    expect(byId["legacy-review"].status).toBe("reviewing");
  });

  it("listContents leaves non-legacy statuses untouched", async () => {
    await seedLegacyContent("modern", "publish_ready");
    const contents = await listContents(testDir);
    expect(contents.find((c) => c.id === "modern")!.status).toBe("publish_ready");
  });

  it("getContent normalizes legacy status on single read", async () => {
    await seedLegacyContent("legacy-one", "review");
    const content = await getContent("legacy-one", testDir);
    expect(content!.status).toBe("reviewing");
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

// ─── 采纳裁决（PRD-v4 §8 三键落库） ─────────────────────────────────────────────

describe("adoption verdicts", () => {
  let adoptDir: string;
  beforeEach(async () => {
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    adoptDir = await fsp.mkdtemp(path.join(os.tmpdir(), "autocrew-adoption-"));
  });
  afterEach(async () => {
    const fsp = await import("node:fs/promises");
    await fsp.rm(adoptDir, { recursive: true, force: true });
  });

  it("recordAdoption 落库、可改判覆盖、重启可读回", async () => {
    const { saveContent, recordAdoption, getContent } = await import("./local-store.js");
    const c = await saveContent({ title: "t", body: "b", status: "draft_ready", tags: [], hashtags: [] }, adoptDir);
    const updated = await recordAdoption(c.id, "light_edit", adoptDir);
    expect(updated?.adoption?.verdict).toBe("light_edit");
    const again = await recordAdoption(c.id, "adopted", adoptDir);
    expect(again?.adoption?.verdict).toBe("adopted");
    const persisted = await getContent(c.id, adoptDir);
    expect(persisted?.adoption?.verdict).toBe("adopted");
    expect(persisted?.adoption?.recordedAt).toBeTruthy();
  });

  it("recordAdoption 不存在的稿 → null", async () => {
    const { recordAdoption } = await import("./local-store.js");
    expect(await recordAdoption("content-nope", "adopted", adoptDir)).toBeNull();
  });

  it("adoptionStats：未裁决不进分母，rate=(采纳+轻改)/已裁决；无裁决 → rate null 而非假 0%", async () => {
    const { saveContent, recordAdoption, adoptionStats } = await import("./local-store.js");
    const empty = await adoptionStats(adoptDir);
    expect(empty.judged).toBe(0);
    expect(empty.rate).toBeNull();

    const mk = () => saveContent({ title: "t", body: "b", status: "draft_ready", tags: [], hashtags: [] }, adoptDir);
    const a = await mk();
    const b = await mk();
    const c = await mk();
    await mk(); // 第 4 篇不裁决——不得进分母
    await recordAdoption(a.id, "adopted", adoptDir);
    await recordAdoption(b.id, "light_edit", adoptDir);
    await recordAdoption(c.id, "rewritten", adoptDir);

    const stats = await adoptionStats(adoptDir);
    expect(stats.judged).toBe(3);
    expect(stats.adopted).toBe(1);
    expect(stats.lightEdit).toBe(1);
    expect(stats.rewritten).toBe(1);
    expect(stats.rate).toBeCloseTo(2 / 3);
  });
});

// ─── 软删除 / 回收站（qingmo 设计细节:可删、可恢复,读侧默认过滤） ────────────

describe("soft delete + trash", () => {
  let trashDir: string;
  beforeEach(async () => {
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    trashDir = await fsp.mkdtemp(path.join(os.tmpdir(), "autocrew-trash-"));
  });
  afterEach(async () => {
    const fsp = await import("node:fs/promises");
    await fsp.rm(trashDir, { recursive: true, force: true });
  });

  it("content:删除后 listContents 不见、trash 可见、恢复后回来", async () => {
    const { saveContent, softDeleteContent, restoreContent, listContents, listTrash } = await import("./local-store.js");
    const c = await saveContent({ title: "t", body: "b", status: "draft_ready", tags: [], hashtags: [] }, trashDir);
    expect(await softDeleteContent(c.id, trashDir)).not.toBeNull();
    expect((await listContents(trashDir)).find((x) => x.id === c.id)).toBeUndefined();
    const trash = await listTrash(trashDir);
    expect(trash.contents.map((x) => x.id)).toContain(c.id);
    await restoreContent(c.id, trashDir);
    expect((await listContents(trashDir)).find((x) => x.id === c.id)).toBeDefined();
    expect((await listTrash(trashDir)).contents).toHaveLength(0);
  });

  it("topic:删除后 listTopics 不见、trash 可见、恢复后回来;不存在 → null", async () => {
    const { saveTopic, softDeleteTopic, restoreTopic, listTopics, listTrash } = await import("./local-store.js");
    const t = await saveTopic({ title: "想法", description: "d", tags: [] }, trashDir);
    expect(await softDeleteTopic(t.id, trashDir)).not.toBeNull();
    expect((await listTopics(trashDir)).find((x) => x.id === t.id)).toBeUndefined();
    expect((await listTrash(trashDir)).topics.map((x) => x.id)).toContain(t.id);
    await restoreTopic(t.id, trashDir);
    expect((await listTopics(trashDir)).find((x) => x.id === t.id)).toBeDefined();
    expect(await softDeleteTopic("topic-nope", trashDir)).toBeNull();
  });

  it("已删稿不进采纳率分母", async () => {
    const { saveContent, recordAdoption, softDeleteContent, adoptionStats } = await import("./local-store.js");
    const c = await saveContent({ title: "t", body: "b", status: "draft_ready", tags: [], hashtags: [] }, trashDir);
    await recordAdoption(c.id, "adopted", trashDir);
    await softDeleteContent(c.id, trashDir);
    expect((await adoptionStats(trashDir)).judged).toBe(0);
  });
});
