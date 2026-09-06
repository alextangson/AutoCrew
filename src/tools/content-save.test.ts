import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeContentSave } from "./content-save.js";
import { recordDiff, listDiffs } from "../modules/learnings/diff-tracker.js";
import { getContent } from "../storage/local-store.js";

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
