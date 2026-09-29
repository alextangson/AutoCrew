import { contentFile, contentRoot, safeProjectPath } from "../../storage/content-project.js";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, getCoverReview, getDataDir, type Asset, type Content } from "../../storage/local-store.js";
import { sha256File } from "../video/handoff/manifest.js";
import { registeredPackage } from "../production/publish-gate.js";
import { verifyCheck, type CheckedPlatform } from "./review-gate/check.js";
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

function assetPath(contentId: string, root: string, video: Asset): string {
  // 原地登记的成片留在项目的 07-delivery 里（P6 §13.4-F），按项目内路径找
  return video.projectPath ? safeProjectPath(contentRoot(contentId, root), video.projectPath) : contentFile(contentId, root, "assets", video.filename);
}

/**
 * 旧路径（没按本体走的稿）发哪一份成片：只认登记记录（video.final）的素材身份并核 sha（摘自 confident-raman 7c2d5f2）。
 * 「最新视频素材」回退已删（本体 §5）：没登记过就不发。
 */
async function legacyVideoPath(content: Content, root: string): Promise<string> {
  const final = content.video?.final;
  if (!final) throw new Error("没有登记过的成片：先登记（成片与封面由创始人批准）再发；不再拿最新的视频素材顶上");
  const asset = (content.assets ?? []).find((a) => a.type === "video" && a.filename === final.asset_filename);
  if (!asset) throw new Error(`登记的成片素材不见了（${final.asset_filename}）：重新登记后再发`);
  const file = assetPath(content.id, root, asset);
  if (!(await existingFile(file))) throw new Error(`视频成片文件不存在：${file}`);
  if ((await sha256File(file)) !== final.sha256) throw new Error(`登记的成片字节变了（sha256 与登记记录不符）：${file}——重新登记确认过的那一版再发`);
  return file;
}

async function legacyCoverPath(contentId: string, root: string): Promise<string> {
  const approvedCover = (await getCoverReview(contentId, root))?.approvedImagePath;
  if (!approvedCover) throw new Error("没有已批准的封面；请先完成封面评审");
  const coverPath = path.isAbsolute(approvedCover) ? approvedCover : contentFile(contentId, root, approvedCover);
  if (!(await existingFile(coverPath))) throw new Error(`已批准的封面文件不存在：${coverPath}`);
  return coverPath;
}

/** 按本体走的稿：只取当前有效登记记录里的成片与 3:4 封面，发前核批准与字节（§5） */
async function publishFiles(content: Content, root: string): Promise<{ videoPath: string; coverPath: string }> {
  const gated = await registeredPackage(content, root);
  if (gated && !gated.ok) throw new Error(gated.error);
  if (gated?.ok) return { videoPath: gated.files.video, coverPath: gated.files.cover34 };
  return { videoPath: await legacyVideoPath(content, root), coverPath: await legacyCoverPath(content.id, root) };
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

  const { videoPath, coverPath } = await publishFiles(content, root);

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

// ---- 按平台出包，必须带该平台当前有效的检查（发布前把关 spec §11） ----

export interface CheckedPackage extends Omit<EgoLitePublishPackage, "coverPath"> {
  checkId: string;
  /** 检查记录里的封面：用途槽 + 文件 + sha（发的就是检查过的那几张） */
  covers: Array<{ usage: string; ratio: string; slot?: string; path: string; sha256: string | null }>;
  tags: string[];
  /** 检查时创始人的原话例外（逐字） */
  overrides: Array<{ rule: string; founder_quote: string }>;
}

export interface CheckedPublishResult { packages: CheckedPackage[]; refused: Array<{ check_id: string; platform: string | null; code: string; error: string }> }

/**
 * 每个 check_id 出一个平台的包：检查仍有效（指纹 / payload 重算一致、没有未例外的拦截）才出；
 * 过期或被拦的平台不出包，给指路错误。成片仍按登记记录取（本体发布出口），标题 / 文案 / 标签 / 排期 / 封面取检查过的计划条目。
 */
export async function prepareCheckedPublish(contentId: string, checkIds: string[], dataDir?: string, schedule?: string): Promise<CheckedPublishResult> {
  const root = getDataDir(dataDir);
  const content = await getContent(contentId, root);
  if (!content) throw new Error(`稿件不存在：${contentId}`);
  const out: CheckedPublishResult = { packages: [], refused: [] };
  const video = (await publishFiles(content, root).catch((e: unknown) => e instanceof Error ? e : new Error(String(e))));
  for (const checkId of checkIds) {
    const v = await verifyCheck(contentId, checkId, root);
    if (!v.ok) { out.refused.push({ check_id: checkId, platform: null, code: v.code, error: v.error }); continue; }
    const refuse = checkedRefusal(v.checked, video, schedule);
    if (refuse) { out.refused.push({ check_id: checkId, platform: v.checked.platform, ...refuse }); continue; }
    out.packages.push(checkedPackage(contentId, checkId, v.checked, (video as { videoPath: string }).videoPath));
  }
  return out;
}

/** 出包前最后几道：平台支持、成片就是检查过的那一版、排期只能取检查过的计划（要改就改计划重跑 check） */
function checkedRefusal(c: CheckedPlatform, video: { videoPath: string } | Error, schedule?: string): { code: string; error: string } | null {
  if (!isEgoLitePlatform(c.platform)) return { code: "platform_unsupported", error: `ego lite 视频发布不支持 ${c.platform}` };
  if (video instanceof Error) return { code: "video_unavailable", error: video.message };
  if (!c.video_path || path.resolve(c.video_path) !== path.resolve(video.videoPath)) {
    return { code: "video_not_checked", error: `${c.platform} 检查的成片（${c.video_path ?? "无"}）不是登记出口的成片（${video.videoPath}）：发布包不能换片，改计划指向登记成片后重跑 check` };
  }
  const s = schedule?.trim();
  if (s && s !== (c.entry.scheduled_at ?? "")) return { code: "schedule_not_checked", error: "排期取检查过的计划；要改排期就改计划里的 scheduled_at 后重跑 check" };
  return null;
}

function checkedPackage(contentId: string, checkId: string, c: CheckedPlatform, videoPath: string): CheckedPackage {
  const platform = c.platform as EgoLiteVideoPlatform;
  return {
    provider: "ego-lite", contentId, platform, taskSpaceName: `autocrew-publish-${platform}-${contentId}`, publishUrl: EGO_LITE_PUBLISH_URLS[platform],
    title: c.entry.title, caption: c.entry.caption, tags: c.entry.tags, videoPath, checkId, covers: c.covers,
    overrides: c.overrides.map((o) => ({ rule: o.rule, founder_quote: o.founder_quote })),
    ...(c.entry.scheduled_at ? { schedule: c.entry.scheduled_at } : {}), requiresFinalConfirmation: true, nextAction: "open_and_fill_only",
  };
}
