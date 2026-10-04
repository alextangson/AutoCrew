import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeContentSave } from "./content-save.js";
import { recordDiff, listDiffs } from "../modules/learnings/diff-tracker.js";
import { shouldDistillStyle } from "../modules/learnings/style-distiller.js";
import { getContent, listContents, saveContent, saveTopic } from "../storage/local-store.js";
import { putOnSlate } from "../modules/meetings/slate.test-helper.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-content-save-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("executeContentSave", () => {
  describe("update with body change", () => {
    it("should record a diff when body is updated", async () => {
      // Create initial content
      const createRes = await executeContentSave({
        action: "save",
        title: "Test",
        body: "Original body",
        _dataDir: testDir,
      });
      expect(createRes.ok).toBe(true);
      const contentId = (createRes.content as any).id;

      // Update with different body
      const updateRes = await executeContentSave({
        action: "update",
        id: contentId,
        body: "Updated body",
        _dataDir: testDir,
      });
      expect(updateRes.ok).toBe(true);

      // Verify diff was recorded
      const diffs = await listDiffs({ contentId }, testDir);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].field).toBe("body");
      expect(diffs[0].before).toBe("Original body");
      expect(diffs[0].after).toBe("Updated body");
    });

    it("should not record a diff when body doesn't change", async () => {
      // Create initial content
      const createRes = await executeContentSave({
        action: "save",
        title: "Test",
        body: "Original body",
        _dataDir: testDir,
      });
      expect(createRes.ok).toBe(true);
      const contentId = (createRes.content as any).id;

      // Update without changing body (update title only)
      const updateRes = await executeContentSave({
        action: "update",
        id: contentId,
        title: "New Title",
        _dataDir: testDir,
      });
      expect(updateRes.ok).toBe(true);

      // Verify no diff was recorded
      const diffs = await listDiffs({ contentId }, testDir);
      expect(diffs).toHaveLength(0);

      // Title-only update must NOT destroy the body (undefined-key regression)
      const getRes = await executeContentSave({
        action: "get",
        id: contentId,
        _dataDir: testDir,
      });
      expect((getRes.content as any).title).toBe("New Title");
      expect((getRes.content as any).body).toBe("Original body");
    });

    it("should preserve title when updating body only", async () => {
      const createRes = await executeContentSave({
        action: "save",
        title: "Keep Me",
        body: "Original body",
        _dataDir: testDir,
      });
      expect(createRes.ok).toBe(true);
      const contentId = (createRes.content as any).id;

      const updateRes = await executeContentSave({
        action: "update",
        id: contentId,
        body: "Updated body",
        _dataDir: testDir,
      });
      expect(updateRes.ok).toBe(true);

      const getRes = await executeContentSave({
        action: "get",
        id: contentId,
        _dataDir: testDir,
      });
      expect((getRes.content as any).title).toBe("Keep Me");
      expect((getRes.content as any).body).toBe("Updated body");
    });

    it("should thread diff_note into the recorded diff's changeType", async () => {
      const createRes = await executeContentSave({
        action: "save",
        title: "Test",
        body: "Original body",
        _dataDir: testDir,
      });
      expect(createRes.ok).toBe(true);
      const contentId = (createRes.content as any).id;

      const updateRes = await executeContentSave({
        action: "update",
        id: contentId,
        body: "Updated body",
        diff_note: "去掉AI腔，口语化",
        _dataDir: testDir,
      });
      expect(updateRes.ok).toBe(true);

      const savedVersion = await getContent(contentId, testDir);
      expect(savedVersion?.versions.at(-1)?.note).toBe("去掉AI腔，口语化");

      const diffs = await listDiffs({ contentId }, testDir);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].changeType).toBe("去掉AI腔，口语化");
    });

    it("should include warning in result when recordDiff fails", async () => {
      // Create initial content
      const createRes = await executeContentSave({
        action: "save",
        title: "Test",
        body: "Original body",
        _dataDir: testDir,
      });
      expect(createRes.ok).toBe(true);
      const contentId = (createRes.content as any).id;

      // Make learnings dir unwritable to simulate recordDiff failure
      const learningsDir = path.join(testDir, "learnings");
      await fs.mkdir(learningsDir, { recursive: true });
      await fs.chmod(learningsDir, 0o444);

      try {
        // Update with different body
        const updateRes = await executeContentSave({
          action: "update",
          id: contentId,
          body: "Updated body",
          _dataDir: testDir,
        });

        // Save should still succeed
        expect(updateRes.ok).toBe(true);
        // But should have a warning about diff recording
        expect((updateRes as any).warning).toBeTruthy();
        expect((updateRes as any).warning).toMatch(/diff.*失败|recording.*failed/i);

        // Verify content was still updated
        const getRes = await executeContentSave({
          action: "get",
          id: contentId,
          _dataDir: testDir,
        });
        expect((getRes.content as any).body).toBe("Updated body");
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(learningsDir, 0o755);
      }
    });

    it("should handle recordDiff failure with deps injection", async () => {
      // Create initial content
      const createRes = await executeContentSave({
        action: "save",
        title: "Test",
        body: "Original body",
        _dataDir: testDir,
      });
      expect(createRes.ok).toBe(true);
      const contentId = (createRes.content as any).id;

      // Mock recordDiff to throw
      const failingRecordDiff = vi.fn().mockRejectedValue(new Error("Simulated recordDiff failure"));

      // Update with different body using mocked recordDiff
      const updateRes = await executeContentSave(
        {
          action: "update",
          id: contentId,
          body: "Updated body",
          _dataDir: testDir,
        },
        { recordDiffImpl: failingRecordDiff }
      );

      // Save should still succeed
      expect(updateRes.ok).toBe(true);
      // Should have a warning
      expect((updateRes as any).warning).toBeTruthy();

      // Verify content was still updated
      const getRes = await executeContentSave({
        action: "get",
        id: contentId,
        _dataDir: testDir,
      });
      expect((getRes.content as any).body).toBe("Updated body");
    });
  });

  describe("auto style distill on update", () => {
    const fakeResult = {
      newRules: [{ rule: "多用口语", source: "auto_distilled", confidence: 0.8 }],
      skippedDuplicates: 0,
      diffsAnalyzed: 3,
      summary: "🎯 学到 1 条新偏好：多用口语",
    };

    async function seedContent(): Promise<string> {
      const createRes = await executeContentSave({
        action: "save",
        title: "T",
        body: "Original body",
        _dataDir: testDir,
      });
      expect(createRes.ok).toBe(true);
      return (createRes.content as any).id;
    }

    it("auto-distills and returns styleLearned when enough diffs accumulated", async () => {
      const contentId = await seedContent();
      const shouldDistillImpl = vi.fn().mockResolvedValue(true);
      const distillImpl = vi.fn().mockResolvedValue(fakeResult);

      const updateRes = await executeContentSave(
        { action: "update", id: contentId, body: "Updated body", _dataDir: testDir },
        { shouldDistillImpl, distillImpl },
      );

      expect(updateRes.ok).toBe(true);
      expect(shouldDistillImpl).toHaveBeenCalledWith(testDir);
      expect(distillImpl).toHaveBeenCalledWith(testDir);
      expect((updateRes as any).styleLearned).toEqual(fakeResult);
    });

    it("MCP edits persist all diffs without background distillation when the real threshold is reached", async () => {
      const contentId = await seedContent();
      const distillImpl = vi.fn().mockResolvedValue(fakeResult);
      // 第一次写自动认领并回令牌，之后每次都带上（P6 §3.8：同宿主不再免检）
      let claimToken: string | undefined;
      for (let index = 0; index < 3; index++) {
        const updated = await executeContentSave({
          action: "update", id: contentId, body: `Host edit ${index}`, _host: "claude-desktop-test", _dataDir: testDir,
          ...(claimToken ? { claim_token: claimToken } : {}),
        }, { distillImpl });
        expect(updated.ok).toBe(true);
        expect((updated as any).styleLearned).toBeUndefined();
        claimToken = (updated as any).claim_token;
        expect(claimToken).toMatch(/^clm-/);
      }
      expect(await listDiffs({ contentId }, testDir)).toHaveLength(3);
      expect(await shouldDistillStyle(testDir)).toBe(true);
      expect((await getContent(contentId, testDir))?.body).toBe("Host edit 2");
      expect(distillImpl).not.toHaveBeenCalled();
    });

    it("does not distill when not enough diffs accumulated", async () => {
      const contentId = await seedContent();
      const shouldDistillImpl = vi.fn().mockResolvedValue(false);
      const distillImpl = vi.fn();

      const updateRes = await executeContentSave(
        { action: "update", id: contentId, body: "Updated body", _dataDir: testDir },
        { shouldDistillImpl, distillImpl },
      );

      expect(updateRes.ok).toBe(true);
      expect(distillImpl).not.toHaveBeenCalled();
      expect((updateRes as any).styleLearned).toBeUndefined();
    });

    it("keeps the save successful when distill throws", async () => {
      const contentId = await seedContent();
      const shouldDistillImpl = vi.fn().mockResolvedValue(true);
      const distillImpl = vi.fn().mockRejectedValue(new Error("no model provider"));

      const updateRes = await executeContentSave(
        { action: "update", id: contentId, body: "Updated body", _dataDir: testDir },
        { shouldDistillImpl, distillImpl },
      );

      expect(updateRes.ok).toBe(true);
      expect((updateRes as any).styleLearned).toBeUndefined();

      const getRes = await executeContentSave({ action: "get", id: contentId, _dataDir: testDir });
      expect((getRes.content as any).body).toBe("Updated body");
    });

    it("does not distill when body is unchanged", async () => {
      const contentId = await seedContent();
      const shouldDistillImpl = vi.fn().mockResolvedValue(true);
      const distillImpl = vi.fn();

      const updateRes = await executeContentSave(
        { action: "update", id: contentId, title: "New title", _dataDir: testDir },
        { shouldDistillImpl, distillImpl },
      );

      expect(updateRes.ok).toBe(true);
      expect(shouldDistillImpl).not.toHaveBeenCalled();
      expect(distillImpl).not.toHaveBeenCalled();
    });
  });

  describe("create", () => {
    it("should not record a diff when creating new content", async () => {
      const res = await executeContentSave({
        action: "save",
        title: "New Content",
        body: "New body",
        _dataDir: testDir,
      });
      expect(res.ok).toBe(true);

      const contentId = (res.content as any).id;
      const diffs = await listDiffs({ contentId }, testDir);
      expect(diffs).toHaveLength(0);
    });
  });

  describe("other actions", () => {
    it("should not record diffs for list, get, or siblings actions", async () => {
      const createRes = await executeContentSave({
        action: "save",
        title: "Test",
        body: "Body",
        _dataDir: testDir,
      });
      expect(createRes.ok).toBe(true);
      const contentId = (createRes.content as any).id;

      // Test list (should not try to record diffs)
      const listRes = await executeContentSave({
        action: "list",
        _dataDir: testDir,
      });
      expect(listRes.ok).toBe(true);

      // Test get (should not try to record diffs)
      const getRes = await executeContentSave({
        action: "get",
        id: contentId,
        _dataDir: testDir,
      });
      expect(getRes.ok).toBe(true);

      // No diffs should have been recorded
      const diffs = await listDiffs({ contentId }, testDir);
      expect(diffs).toHaveLength(0);
    });
  });
});

// ─── adoption action（采纳三键 → 北极星读数，PRD-v4 §8） ──────────────────────

describe("executeContentSave adoption", () => {
  let adoptDir: string;
  beforeEach(async () => {
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    adoptDir = await fsp.mkdtemp(path.join(os.tmpdir(), "autocrew-adopt-tool-"));
  });
  afterEach(async () => {
    const fsp = await import("node:fs/promises");
    await fsp.rm(adoptDir, { recursive: true, force: true });
  });

  async function mkContent(): Promise<string> {
    const { saveContent } = await import("../storage/local-store.js");
    const c = await saveContent({ title: "t", body: "b", status: "draft_ready", tags: [], hashtags: [] }, adoptDir);
    return c.id;
  }

  it("happy path：落裁决并附带全局采纳率（toast 白盒读数）", async () => {
    const { executeContentSave } = await import("./content-save.js");
    const id = await mkContent();
    const r = (await executeContentSave({ action: "adoption", id, verdict: "light_edit", _dataDir: adoptDir })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    const content = r.content as { adoption?: { verdict: string } };
    expect(content.adoption?.verdict).toBe("light_edit");
    const stats = r.stats as { judged: number; adopted: number; lightEdit: number; rate: number | null };
    expect(stats.judged).toBe(1);
    expect(stats.lightEdit).toBe(1);
    expect(stats.rate).toBe(1);
  });

  it("V5.0 自由文本原因:rewritten + reason_note 落库(截断 200);非 rewritten 忽略", async () => {
    const { executeContentSave } = await import("./content-save.js");
    const id = await mkContent();
    const long = "这段太软了,论证不够狠。".repeat(30);
    const r = (await executeContentSave({
      action: "adoption", id, verdict: "rewritten", reason_note: long, _dataDir: adoptDir,
    })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    const content = r.content as { adoption?: { verdict: string; reasonNote?: string } };
    expect(content.adoption?.reasonNote).toBeDefined();
    expect(content.adoption!.reasonNote!.length).toBe(200);

    const id2 = await mkContent();
    const r2 = (await executeContentSave({
      action: "adoption", id: id2, verdict: "adopted", reason_note: "不该带原因", _dataDir: adoptDir,
    })) as Record<string, unknown>;
    const c2 = r2.content as { adoption?: { reasonNote?: string } };
    expect(c2.adoption?.reasonNote).toBeUndefined();
  });

  it("verdict 非法或缺失 → 明确报错，不落库", async () => {
    const { executeContentSave } = await import("./content-save.js");
    const { getContent } = await import("../storage/local-store.js");
    const id = await mkContent();
    const bad = (await executeContentSave({ action: "adoption", id, verdict: "meh", _dataDir: adoptDir })) as Record<string, unknown>;
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("verdict");
    const missing = (await executeContentSave({ action: "adoption", id, _dataDir: adoptDir })) as Record<string, unknown>;
    expect(missing.ok).toBe(false);
    const persisted = await getContent(id, adoptDir);
    expect(persisted?.adoption).toBeUndefined();
  });

  it("id 缺失 / 不存在 → 报错", async () => {
    const { executeContentSave } = await import("./content-save.js");
    const noId = (await executeContentSave({ action: "adoption", verdict: "adopted", _dataDir: adoptDir })) as Record<string, unknown>;
    expect(noId.ok).toBe(false);
    const gone = (await executeContentSave({ action: "adoption", id: "content-nope", verdict: "adopted", _dataDir: adoptDir })) as Record<string, unknown>;
    expect(gone.ok).toBe(false);
  });
});

// ─── transition → published：到「已发布」的另一条路同样在发布时刻推导采纳判定 ──

describe("executeContentSave transition → published", () => {
  it("流转到 published 时自动落 derived 判定，并随流转结果返回", async () => {
    const { saveContent, getContent } = await import("../storage/local-store.js");
    const c = await saveContent(
      { title: "t", body: "AI 写的正文,原样发出去。", status: "publishing", tags: [], hashtags: [] },
      testDir,
    );

    const r = (await executeContentSave({
      action: "transition", id: c.id, target_status: "published", _dataDir: testDir,
    })) as { ok: boolean; adoption?: { verdict: string; derived?: boolean } };

    expect(r.ok).toBe(true);
    expect(r.adoption?.verdict).toBe("adopted");
    expect((await getContent(c.id, testDir))?.adoption?.derived).toBe(true);
  });

  it("非 published 的流转不判定", async () => {
    const { saveContent, getContent } = await import("../storage/local-store.js");
    const c = await saveContent(
      { title: "t", body: "正文", status: "draft_ready", tags: [], hashtags: [] },
      testDir,
    );

    const r = (await executeContentSave({
      action: "transition", id: c.id, target_status: "reviewing", _dataDir: testDir,
    })) as { ok: boolean; adoption?: unknown };

    expect(r.ok).toBe(true);
    expect(r.adoption).toBeUndefined();
    expect((await getContent(c.id, testDir))?.adoption).toBeUndefined();
  });
});


describe("content_id 别名（P3b 真机 2026-09-06）", () => {
  it("get 用 content_id 也能命中，与 id 同一结果", async () => {
    const { executeContentSave } = await import("./content-save.js");
    const saved = (await executeContentSave({ action: "save", title: "别名", body: "正文", platform: "wechat", _dataDir: testDir })) as { ok: boolean; content?: { id: string } };
    const cid = saved.content?.id ?? (saved as { id?: string }).id;
    expect(cid).toBeTruthy();
    const byId = (await executeContentSave({ action: "get", id: cid, _dataDir: testDir })) as { ok: boolean };
    const byAlias = (await executeContentSave({ action: "get", content_id: cid, _dataDir: testDir })) as { ok: boolean };
    expect(byId.ok).toBe(true);
    expect(byAlias.ok).toBe(true);
  });
});

describe("MCP content storage cannot bypass writer submission", () => {
  const run = (params: Record<string, unknown>) => executeContentSave(
    { _host: "claude_desktop", _dataDir: testDir, ...params },
    { shouldDistillImpl: async () => false },
  );

  it("带正文的平台变体须明确人工导入，拒绝前不创建稿件或修改兄弟关系", async () => {
    const topic = await saveTopic({ title: "返工记录", description: "按真实经历写", tags: [] }, testDir);
    const sibling = await saveContent({ title: "已有稿件", body: "原文", topicId: topic.id, platform: "douyin" }, testDir);
    for (const extra of [{}, { source: "manual_import", import_reason: " " }]) {
      const result = await run({ action: "create_variant", topicId: topic.id, platform: "wechat_mp", body: "宿主刚生成的新稿", ...extra });
      expect(result).toMatchObject({ ok: false, code: "writer_submission_required" });
    }
    expect(await listContents(testDir)).toHaveLength(1);
    expect(await getContent(sibling.id, testDir)).toEqual(sibling);
  });

  it("用户已有成稿可导入平台变体，明确未审状态且不批准", async () => {
    const topic = await saveTopic({ title: "返工记录", description: "素材", tags: [] }, testDir);
    const result = await run({
      action: "create_variant", topicId: topic.id, platform: "wechat_mp", body: "用户亲写的原稿",
      source: "manual_import", import_reason: "用户提供了已有成稿并要求整理进平台变体",
    });
    expect(result).toMatchObject({ ok: true, saved: true, quality_status: "unreviewed", needs_attention: true, writing_source: { kind: "manual_import" } });
    expect("content" in result && result.content).toMatchObject({ body: "用户亲写的原稿", status: "topic_saved" });
    const id = (result as { content: { id: string } }).content.id;
    expect(await getContent(id, testDir)).toMatchObject({ writingSource: { kind: "manual_import", reason: "用户提供了已有成稿并要求整理进平台变体" } });
  });

  it("manual_import 导入把来源落在稿件上，get/list 都看得到（§13.4-B）", async () => {
    const saved = await run({ action: "save", title: "导入稿", body: "已录口播原文", platform: "douyin", source: "manual_import", import_reason: " 创作者要求导入本地稿 " });
    expect(saved).toMatchObject({ ok: true, writing_source: { kind: "manual_import" } });
    const id = (saved as { content: { id: string } }).content.id;
    const expected = { kind: "manual_import", reason: "创作者要求导入本地稿", importedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) };
    expect(await getContent(id, testDir)).toMatchObject({ status: "draft_ready", writingSource: expected });
    expect(await run({ action: "get", id })).toMatchObject({ content: { writingSource: expected } });
    const listed = await run({ action: "list" }) as { contents: Array<{ id: string; writingSource?: unknown }> };
    expect(listed.contents.find((c) => c.id === id)?.writingSource).toEqual(expected);
  });

  it("非导入的 save 不带来源", async () => {
    const saved = await executeContentSave({ action: "save", title: "工作台稿", body: "正文", _dataDir: testDir });
    expect(await getContent((saved as { content: { id: string } }).content.id, testDir)).not.toHaveProperty("writingSource");
  });

  it("无正文可建平台占位，但不能再用 update 填正文绕过 submit", async () => {
    const topic = await saveTopic({ title: "返工记录", description: "这里只是选题描述", tags: [] }, testDir);
    await putOnSlate(testDir, topic.id);
    const placeholder = await run({ action: "create_variant", topicId: topic.id, platform: "wechat_mp" });
    expect(placeholder.ok).toBe(true);
    if (!("content" in placeholder) || !placeholder.content) throw new Error("missing content");
    const before = await getContent(placeholder.content.id, testDir);
    const result = await run({ action: "update", id: placeholder.content.id, title: "绕过的新标题", body: "刚生成的新稿" });
    expect(result).toMatchObject({ ok: false, code: "writer_submission_required" });
    expect(await getContent(placeholder.content.id, testDir)).toEqual(before);
  });

  it("空白稿和未交稿的写作包均不能用 update 填正文，manual_import 不解除该约束", async () => {
    const blank = await saveContent({ title: "空白稿", body: "  ", status: "drafting" }, testDir);
    const pending = await saveContent({
      title: "写作占位", body: "准备中的占位文字", status: "drafting",
      pack: { packId: "wp-pending", issuedAt: "2026-09-22T00:00:00Z", host: "claude_desktop" },
    }, testDir);
    for (const content of [blank, pending]) {
      const before = await getContent(content.id, testDir);
      const result = await run({ action: "update", id: content.id, body: "试图跳过交稿的新正文", source: "manual_import", import_reason: "导入已有稿件" });
      expect(result).toMatchObject({ ok: false, code: "writer_submission_required" });
      expect(await getContent(content.id, testDir)).toEqual(before);
    }
  });

  it("正常旧稿及已提交稿仍可人工修订，旧正文和来源不被误认成占位", async () => {
    const legacy = await saveContent({ title: "旧稿", body: "旧正文", status: "revision" }, testDir);
    const submitted = await saveContent({
      title: "交过的稿", body: "已交正文", status: "revision",
      pack: { packId: "wp-submitted", issuedAt: "2026-09-22T00:00:00Z", submittedAt: "2026-09-22T01:00:00Z", host: "claude_desktop" },
      writtenBy: { kind: "host", host: "claude_desktop" },
    }, testDir);
    for (const content of [legacy, submitted]) {
      const result = await run({ action: "update", id: content.id, body: "按作者反馈修订的正文", diff_note: "保留作者真实经历" });
      expect(result.ok).toBe(true);
      expect((await getContent(content.id, testDir))?.body).toBe("按作者反馈修订的正文");
    }
  });

  it("占位稿的纯元数据更新仍可用，非 MCP 内部写入兼容", async () => {
    const blank = await saveContent({ title: "旧标题", body: "", status: "drafting" }, testDir);
    expect((await run({ action: "update", id: blank.id, title: "纠正标题" })).ok).toBe(true);
    expect((await getContent(blank.id, testDir))?.body).toBe("");
    const internal = await run({ action: "update", id: blank.id, body: "内部已完成的正文", _host: undefined });
    expect(internal.ok).toBe(true);
    expect((await getContent(blank.id, testDir))?.body).toBe("内部已完成的正文");
    const topic = await saveTopic({ title: "内部选题", description: "素材", tags: [] }, testDir);
    await putOnSlate(testDir, topic.id);
    const internalVariant = await run({ action: "create_variant", topicId: topic.id, platform: "douyin", body: "内部平台稿", _host: undefined });
    expect(internalVariant.ok).toBe(true);
  });
});

describe("「剪辑中」只能经交接进入（§13.4-C）", () => {
  const seedApproved = () => saveContent({ title: "口播稿", body: "正文", platform: "douyin", status: "approved", tags: [] }, testDir);

  it.each([{}, { _host: "claude" }])("transition / update{status} / save{status} 都拒绝并说明怎么交接（%o）", async (via) => {
    const c = await seedApproved();
    const base = { _dataDir: testDir, ...via };
    const moved = await executeContentSave({ ...base, action: "transition", id: c.id, target_status: "editing", from_status: "approved", force: true });
    expect(moved).toMatchObject({ ok: false, code: "editing_requires_handoff", blocked: true });
    expect(String((moved as { error: string }).error)).toContain("autocrew_video handoff");
    const token = (moved as { claim_token?: string }).claim_token;
    const updated = await executeContentSave({ ...base, action: "update", id: c.id, title: "新标题", status: "editing", ...(token ? { claim_token: token } : {}) });
    expect(updated).toMatchObject({ ok: false, code: "editing_requires_handoff" });
    expect((await getContent(c.id, testDir))?.status).toBe("approved");
    const saved = await executeContentSave({ ...base, action: "save", title: "直接建", body: "正文", platform: "douyin", status: "editing", ...(via._host ? { source: "manual_import", import_reason: "x" } : {}) });
    if (via._host) expect(saved).toMatchObject({ ok: true, content: { status: "draft_ready" } });
    else expect(saved).toMatchObject({ ok: false, code: "editing_requires_handoff" });
    expect((await listContents(testDir)).filter((x) => x.status === "editing")).toEqual([]);
  });

  it.each([{}, { _host: "claude" }])("被阶段门拒绝的流转不新占也不续约认领（%o）", async (via) => {
    const c = await seedApproved();
    const base = { _dataDir: testDir, ...via };
    const moved = await executeContentSave({ ...base, action: "transition", id: c.id, target_status: "editing", force: true });
    expect(moved).toMatchObject({ ok: false, code: "editing_requires_handoff" });
    expect(moved).not.toHaveProperty("claim_token");
    const updated = await executeContentSave({ ...base, action: "update", id: c.id, title: "新标题", status: "editing" });
    expect(updated).toMatchObject({ ok: false, code: "editing_requires_handoff" });
    const after = (await getContent(c.id, testDir))!;
    expect(after.claim).toBeUndefined();
    expect(after.title).toBe("口播稿");
  });

  it("已有认领时被拒的流转不改认领（不续约）", async () => {
    const c = await seedApproved();
    const first = await executeContentSave({ _dataDir: testDir, _host: "claude", action: "update", id: c.id, title: "认领一下" });
    const before = (await getContent(c.id, testDir))!.claim;
    expect(before).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));
    const token = (first as { claim_token?: string }).claim_token;
    await executeContentSave({ _dataDir: testDir, _host: "claude", action: "transition", id: c.id, target_status: "editing", claim_token: token });
    expect((await getContent(c.id, testDir))!.claim).toEqual(before);
  });
});
