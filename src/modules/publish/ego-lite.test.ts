import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addAsset,
  approveCoverVariant,
  saveContent,
  saveCoverReview,
  updateContent,
} from "../../storage/local-store.js";
import {
  EGO_LITE_PUBLISH_URLS,
  EGO_LITE_VIDEO_PLATFORMS,
  prepareEgoLitePublish,
  type EgoLiteVideoPlatform,
} from "./ego-lite.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-ego-lite-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function readyContent(platform: EgoLiteVideoPlatform) {
  const content = await saveContent(
    {
      title: "原稿标题",
      body: "原稿正文".repeat(80),
      platform,
      status: "approved",
      tags: [],
      hashtags: ["AI", "创作"],
    },
    dir,
  );

  const sourceVideo = path.join(dir, `${platform}.mp4`);
  await fs.writeFile(sourceVideo, "video");
  await addAsset(
    content.id,
    {
      filename: "final-v2.mp4",
      type: "video",
      managedBy: "video-pipeline",
      renderedRevision: 2,
      sourcePath: sourceVideo,
    },
    dir,
  );

  const cover = path.join(dir, `${platform}-cover.png`);
  await fs.writeFile(cover, "cover");
  await saveCoverReview(
    content.id,
    {
      platform,
      status: "review_pending",
      primaryRatio: platform === "bilibili" ? "16:9" : "3:4",
      variants: [
        {
          label: "a",
          imagePaths: platform === "bilibili" ? { "16:9": cover } : { "3:4": cover },
        },
      ],
    },
    dir,
  );
  await approveCoverVariant(content.id, "a", dir);
  await updateContent(
    content.id,
    {
      videoDone: { renderedRevision: 2, at: "2026-08-31T00:00:00.000Z" },
      videoKit: {
        platform,
        postTitle: "平台标题",
        caption: "平台发布文案 #AI",
        storyboard: [],
        coverText: "封面字",
        coverPrompt: "封面提示词",
        generatedAt: "2026-08-31T00:00:00.000Z",
      },
    },
    dir,
  );
  return { content, cover };
}

describe("prepareEgoLitePublish", () => {
  for (const platform of EGO_LITE_VIDEO_PLATFORMS) {
    it(`为 ${platform} 生成只填表、不自动发布的浏览器包`, async () => {
      const { content, cover } = await readyContent(platform);
      const result = await prepareEgoLitePublish(content.id, dir, "2026-09-01 20:30");

      expect(result).toMatchObject({
        provider: "ego-lite",
        contentId: content.id,
        platform,
        publishUrl: EGO_LITE_PUBLISH_URLS[platform],
        title: "平台标题",
        caption: "平台发布文案 #AI",
        coverPath: cover,
        schedule: "2026-09-01 20:30",
        requiresFinalConfirmation: true,
        nextAction: "open_and_fill_only",
      });
      expect(result.videoPath).toBe(path.join(dir, "contents", content.id, "assets", "final-v2.mp4"));
      expect(result.taskSpaceName).toContain(content.id);
    });
  }

  it("优先选择当前审片版本，不被后来手工挂接的视频覆盖", async () => {
    const { content } = await readyContent("douyin");
    const newer = path.join(dir, "manual.mp4");
    await fs.writeFile(newer, "manual");
    await addAsset(content.id, { filename: "manual.mp4", type: "video", sourcePath: newer }, dir);

    const result = await prepareEgoLitePublish(content.id, dir);
    expect(result.videoPath).toContain("final-v2.mp4");
  });

  it("视频或批准封面缺失时失败关闭，不生成可执行发布包", async () => {
    const content = await saveContent(
      {
        title: "标题",
        body: "正文".repeat(80),
        platform: "douyin",
        status: "approved",
        tags: [],
        hashtags: ["AI"],
      },
      dir,
    );
    await expect(prepareEgoLitePublish(content.id, dir)).rejects.toThrow(/视频成片/);

    const sourceVideo = path.join(dir, "only-video.mp4");
    await fs.writeFile(sourceVideo, "video");
    await addAsset(content.id, { filename: "only-video.mp4", type: "video", sourcePath: sourceVideo }, dir);
    await expect(prepareEgoLitePublish(content.id, dir)).rejects.toThrow(/已批准的封面/);
  });

  it("拒绝四个平台之外的稿件", async () => {
    const content = await saveContent(
      { title: "公众号", body: "正文", platform: "wechat_mp", status: "approved", tags: [], hashtags: [] },
      dir,
    );
    await expect(prepareEgoLitePublish(content.id, dir)).rejects.toThrow(/只支持/);
  });
});
