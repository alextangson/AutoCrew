import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  saveContent,
  saveCoverReview,
  approveCoverVariant,
  transitionStatus,
  updateContent,
  getContent,
} from "../storage/local-store.js";
import { executePrePublish } from "./pre-publish.js";

vi.mock("./review.js", () => ({
  executeReview: vi.fn().mockResolvedValue({
    ok: true,
    passed: true,
    qualityScore: { total: 90 },
    summary: "通过",
  }),
}));

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-prepublish-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("executePrePublish platform-specific checks", () => {
  it("does not require hashtags for WeChat official-account articles", async () => {
    const content = await saveContent(
      {
        title: "一篇可以发布的公众号文章",
        body: "这是公众号正文。".repeat(120),
        platform: "wechat_mp",
        status: "approved",
        tags: [],
      },
      dataDir,
    );

    const result = await executePrePublish({ action: "check", content_id: content.id, _dataDir: dataDir });
    expect("checks" in result).toBe(true);
    if (!("checks" in result)) return;
    expect(result.checks.find((check) => check.name === "Hashtags")).toMatchObject({ status: "skip" });
    expect(result.allPassed).toBe(true);
  });

  for (const platform of ["wechat_video", "bilibili"]) {
    it(`requires an approved cover for ${platform}`, async () => {
      const content = await saveContent(
        {
          title: "这一年 AI 如何重写工作与生活",
          body: "这是一段符合平台长度要求的视频正文。".repeat(30),
          platform,
          status: "approved",
          hashtags: ["AI"],
        },
        dataDir,
      );
      const result = await executePrePublish({ action: "check", content_id: content.id, _dataDir: dataDir });
      expect("checks" in result).toBe(true);
      if (!("checks" in result)) return;
      expect(result.checks.find((check) => check.name === "封面审核")).toMatchObject({ status: "fail" });
    });
  }
});

// --- 阶段门（阶段制 spec §2 最坏输入 / §4 #1）---

describe("发布前检查 · 阶段门", () => {
  /** 六项内容检查全过的视频稿：唯一还能拦住它的就是阶段门 */
  const readyVideo = async (status: "approved" | "cover_pending") => {
    const c = await saveContent(
      {
        title: "这一年 AI 如何重写工作与生活",
        body: "这是一段符合平台长度要求的视频正文。".repeat(30),
        platform: "douyin",
        status: "approved",
        hashtags: ["AI"],
      },
      dataDir,
    );
    await saveCoverReview(
      c.id,
      { platform: "douyin", status: "review_pending", variants: [{ label: "a", imagePaths: { "3:4": "/tmp/a.png" } }] },
      dataDir,
    );
    await approveCoverVariant(c.id, "a", dataDir);
    if (status === "cover_pending") {
      await updateContent(c.id, { videoDone: { renderedRevision: 1, at: "2026-08-25T00:00:00.000Z" } }, dataDir);
      await transitionStatus(c.id, "editing", undefined, dataDir);
      await transitionStatus(c.id, "cover_pending", undefined, dataDir);
    }
    return c.id;
  };

  it("视频稿在 approved 上跑预检：不谎报全过，明示卡在阶段门", async () => {
    const id = await readyVideo("approved");
    const result = await executePrePublish({ action: "check", content_id: id, _dataDir: dataDir });
    expect("checks" in result).toBe(true);
    if (!("checks" in result)) return;
    expect(result.allPassed).toBe(false);
    expect(result.checks.find((c) => c.name === "阶段门")).toMatchObject({ status: "fail" });
    expect(result.summary).toContain("卡在阶段门");
    expect(result.summary).toContain("推进到剪辑");
    // 被拦下就是没进——状态一个字都不许动
    expect((await getContent(id, dataDir))!.status).toBe("approved");
  });

  it("走完剪辑与封面后，预检全过并把稿件推进「待发布」", async () => {
    const id = await readyVideo("cover_pending");
    const result = await executePrePublish({ action: "check", content_id: id, _dataDir: dataDir });
    expect("checks" in result).toBe(true);
    if (!("checks" in result)) return;
    expect(result.allPassed).toBe(true);
    expect((await getContent(id, dataDir))!.status).toBe("publish_ready");
  });

  it("_readOnly：门的判定照报，但一个字都不写盘", async () => {
    const id = await readyVideo("cover_pending");
    const result = await executePrePublish({ action: "check", content_id: id, _dataDir: dataDir, _readOnly: true });
    expect("checks" in result).toBe(true);
    if (!("checks" in result)) return;
    expect(result.allPassed).toBe(true);
    expect((await getContent(id, dataDir))!.status).toBe("cover_pending");
  });

  it("已发布的稿重跑预检不被倒拨回「待发布」", async () => {
    const id = await readyVideo("cover_pending");
    await transitionStatus(id, "published", { force: true }, dataDir);
    await executePrePublish({ action: "check", content_id: id, _dataDir: dataDir });
    expect((await getContent(id, dataDir))!.status).toBe("published");
  });
});
