import fs from "node:fs/promises";
import path from "node:path";
import { getContent, getCoverReview, getDataDir, type Asset } from "../../storage/local-store.js";
import { formatForClipboard } from "./clipboard-publisher.js";

export const EGO_LITE_VIDEO_PLATFORMS = [
  "wechat_video",
  "xiaohongshu",
  "douyin",
  "bilibili",
] as const;

export type EgoLiteVideoPlatform = (typeof EGO_LITE_VIDEO_PLATFORMS)[number];

export const EGO_LITE_PUBLISH_URLS: Record<EgoLiteVideoPlatform, string> = {
  wechat_video: "https://channels.weixin.qq.com/platform/post/create",
  xiaohongshu: "https://creator.xiaohongshu.com/publish/publish",
  douyin: "https://creator.douyin.com/creator-micro/content/upload",
  bilibili: "https://member.bilibili.com/platform/upload/video/frame",
};

export interface EgoLitePublishPackage {
  provider: "ego-lite";
  contentId: string;
  platform: EgoLiteVideoPlatform;
  taskSpaceName: string;
  publishUrl: string;
  title: string;
  caption: string;
  videoPath: string;
  coverPath: string;
  schedule?: string;
  requiresFinalConfirmation: true;
  nextAction: "open_and_fill_only";
}

function isEgoLitePlatform(platform: string): platform is EgoLiteVideoPlatform {
  return (EGO_LITE_VIDEO_PLATFORMS as readonly string[]).includes(platform);
}

async function existingFile(file: string): Promise<string | null> {
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

function preferredVideoAsset(assets: Asset[], renderedRevision?: number): Asset | undefined {
  if (renderedRevision !== undefined) {
    const exact = assets.find(
      (asset) =>
        asset.type === "video" &&
        asset.managedBy === "video-pipeline" &&
        asset.renderedRevision === renderedRevision,
    );
    if (exact) return exact;
  }
  return assets
    .filter((asset) => asset.type === "video")
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))[0];
}

/**
 * Resolve one immutable browser hand-off package from AutoCrew's content truth.
 *
 * This function deliberately does not launch ego-browser or click Publish. The
 * agent-facing skill owns browser control/handoff, while this module owns paths,
 * platform copy and the final-confirmation contract.
 */
export async function prepareEgoLitePublish(
  contentId: string,
  dataDir?: string,
  schedule?: string,
): Promise<EgoLitePublishPackage> {
  const root = getDataDir(dataDir);
  const content = await getContent(contentId, root);
  if (!content) throw new Error(`稿件不存在：${contentId}`);

  const platform = content.platform ?? "";
  if (!isEgoLitePlatform(platform)) {
    throw new Error(
      `ego lite 视频发布只支持：${EGO_LITE_VIDEO_PLATFORMS.join("、")}；当前是 ${platform || "未设置"}`,
    );
  }

  const video = preferredVideoAsset(content.assets ?? [], content.videoDone?.renderedRevision);
  if (!video) throw new Error("没有可发布的视频成片；请先完成剪辑并登记 video 素材");
  const videoPath = path.join(root, "contents", contentId, "assets", video.filename);
  if (!(await existingFile(videoPath))) {
    throw new Error(`视频成片文件不存在：${videoPath}`);
  }

  const coverReview = await getCoverReview(contentId, root);
  const approvedCover = coverReview?.approvedImagePath;
  if (!approvedCover) throw new Error("没有已批准的封面；请先完成封面评审");
  const coverPath = path.isAbsolute(approvedCover)
    ? approvedCover
    : path.join(root, "contents", contentId, approvedCover);
  if (!(await existingFile(coverPath))) {
    throw new Error(`已批准的封面文件不存在：${coverPath}`);
  }

  const kit = content.videoKit;
  const fallback = formatForClipboard(platform, content.title, content.body, content.hashtags ?? []);
  const title = kit?.postTitle?.trim() || fallback.formattedTitle;
  const caption = kit?.caption?.trim() || fallback.formattedBody;

  return {
    provider: "ego-lite",
    contentId,
    platform,
    taskSpaceName: `autocrew-publish-${platform}-${contentId}`,
    publishUrl: EGO_LITE_PUBLISH_URLS[platform],
    title,
    caption,
    videoPath,
    coverPath,
    ...(schedule?.trim() ? { schedule: schedule.trim() } : {}),
    requiresFinalConfirmation: true,
    nextAction: "open_and_fill_only",
  };
}
