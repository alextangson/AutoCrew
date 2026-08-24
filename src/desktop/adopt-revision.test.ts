import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIpcHandlers } from "./ipc.js";
import { saveContent, getContent } from "../storage/local-store.js";
import { listDiffs } from "../modules/learnings/diff-tracker.js";
import { shouldDistillStyle, distillStyleRules } from "../modules/learnings/style-distiller.js";

// 蒸馏这一步不该在收稿测试里真跑模型：门槛与结果由 mock 给，其余导出保持真实
vi.mock("../modules/learnings/style-distiller.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/learnings/style-distiller.js")>()),
  shouldDistillStyle: vi.fn(async () => false),
  distillStyleRules: vi.fn(async () => ({
    newRules: [],
    skippedDuplicates: 0,
    diffsAnalyzed: 3,
    summary: "🎯 学到 1 条新偏好：开头别铺垫",
  })),
}));

let testDir: string;
const handlers = buildIpcHandlers();

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-adopt-"));
  vi.clearAllMocks();
  vi.mocked(shouldDistillStyle).mockResolvedValue(false);
  vi.mocked(distillStyleRules).mockResolvedValue({
    newRules: [],
    skippedDuplicates: 0,
    diffsAnalyzed: 3,
    summary: "🎯 学到 1 条新偏好：开头别铺垫",
  });
});
afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function mkContent() {
  return saveContent({ title: "T", body: "原正文", platform: "wechat_mp", status: "draft_ready", tags: [] }, testDir);
}

describe("draft:adopt_revision", () => {
  it("saves a new version and records learning when before+feedback given", async () => {
    const c = await mkContent();
    const r = await handlers["draft:adopt_revision"]({
      content_id: c.id,
      body: "新正文更口语",
      before: "原正文",
      feedback: "口语一点",
      _dataDir: testDir,
    });
    expect(r.ok).toBe(true);
    const saved = await getContent(c.id, testDir);
    expect(saved?.body).toBe("新正文更口语");
    expect(saved?.versions).toHaveLength(2);
    expect((await listDiffs(undefined, testDir)).length).toBe(1);
  });

  it("does NOT record learning without before (no adopt-gated feedback)", async () => {
    const c = await mkContent();
    const r = await handlers["draft:adopt_revision"]({ content_id: c.id, body: "新正文2", _dataDir: testDir });
    expect(r.ok).toBe(true);
    expect((await listDiffs(undefined, testDir)).length).toBe(0);
  });

  // revise_focus 自己不落库，它的落盘点就是这个 handler（审稿 spec §2.7）
  it("收下改稿 → 审稿结论过期（review.status = stale）", async () => {
    const c = await saveContent(
      {
        title: "T",
        body: "原正文",
        platform: "wechat_mp",
        status: "draft_ready",
        tags: [],
        review: { status: "revised", rounds: 1, fixed: 2, issues: [], reviewedAt: "2026-08-23T00:00:00.000Z" },
      },
      testDir,
    );
    const r = await handlers["draft:adopt_revision"]({ content_id: c.id, body: "收下的新正文", _dataDir: testDir });

    expect(r.ok).toBe(true);
    const saved = await getContent(c.id, testDir);
    expect(saved?.review?.status).toBe("stale");
    expect(saved?.review?.fixed).toBe(2); // 结论其余部分原样保留
  });

  it("没审过的稿收下改稿也不凭空长出 review 字段", async () => {
    const c = await mkContent();
    await handlers["draft:adopt_revision"]({ content_id: c.id, body: "收下的新正文", _dataDir: testDir });
    expect((await getContent(c.id, testDir))?.review).toBeUndefined();
  });

  // 采纳时刻就是学习时刻（对话式修订设计）：攒够 diff 当场蒸馏，回执带走 summary
  it("攒够 diff → 收稿时触发蒸馏，响应带 styleLearned", async () => {
    vi.mocked(shouldDistillStyle).mockResolvedValue(true);
    const c = await mkContent();

    const r = await handlers["draft:adopt_revision"]({
      content_id: c.id,
      body: "新正文更口语",
      before: "原正文",
      feedback: "口语一点",
      _dataDir: testDir,
    });

    expect(r.ok).toBe(true);
    expect(distillStyleRules).toHaveBeenCalledOnce();
    expect((r.styleLearned as { summary?: string })?.summary).toContain("新偏好");
  });

  it("门槛没到 → 不蒸馏，响应也不带 styleLearned", async () => {
    const c = await mkContent();
    const r = await handlers["draft:adopt_revision"]({
      content_id: c.id, body: "新正文2", before: "原正文", feedback: "短一点", _dataDir: testDir,
    });

    expect(r.ok).toBe(true);
    expect(distillStyleRules).not.toHaveBeenCalled();
    expect(r.styleLearned).toBeUndefined();
  });

  it("蒸馏抛错 → 收稿照样成功（稿件已落盘，学习是附加收益）", async () => {
    vi.mocked(shouldDistillStyle).mockResolvedValue(true);
    vi.mocked(distillStyleRules).mockRejectedValue(new Error("没配模型"));
    const c = await mkContent();

    const r = await handlers["draft:adopt_revision"]({
      content_id: c.id, body: "新正文更口语", before: "原正文", feedback: "口语一点", _dataDir: testDir,
    });

    expect(r.ok).toBe(true);
    expect(r.styleLearned).toBeUndefined();
    expect((await getContent(c.id, testDir))?.body).toBe("新正文更口语");
  });

  it("rejects missing body / bad id", async () => {
    const c = await mkContent();
    expect((await handlers["draft:adopt_revision"]({ content_id: c.id, _dataDir: testDir })).ok).toBe(false);
    expect((await handlers["draft:adopt_revision"]({ content_id: "nope", body: "x", _dataDir: testDir })).ok).toBe(false);
  });
});
