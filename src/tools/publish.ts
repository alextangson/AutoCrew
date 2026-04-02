import path from "node:path";
import { Type } from "@sinclair/typebox";
import { getContent } from "../storage/local-store.js";
import { publishWechatMpDraft } from "../modules/publish/wechat-mp.js";
import { publishToXiaohongshu } from "../modules/publish/xiaohongshu-api.js";
import { publishToDouyin } from "../modules/publish/douyin-api.js";
import { loadCookie } from "../modules/auth/cookie-manager.js";

export const publishSchema = Type.Object({
  action: Type.Unsafe<
    "wechat_mp_draft" | "xiaohongshu_publish" | "douyin_publish" | "relay_publish"
  >({
    type: "string",
    enum: ["wechat_mp_draft", "xiaohongshu_publish", "douyin_publish", "relay_publish"],
    description:
      "Publish action. Supported: 'wechat_mp_draft', 'xiaohongshu_publish', 'douyin_publish', 'relay_publish'.",
  }),
  article_path: Type.Optional(
    Type.String({ description: "Absolute or relative path to the markdown article file." }),
  ),
  content_id: Type.Optional(
    Type.String({ description: "AutoCrew content id. If provided, draft.md will be used." }),
  ),
  theme: Type.Optional(
    Type.String({ description: "WeChat formatting theme. Default: newspaper." }),
  ),
  dry_run: Type.Optional(
    Type.Boolean({ description: "Generate assets and show the publish command without pushing." }),
  ),
  skip_images: Type.Optional(
    Type.Boolean({ description: "Skip image generation if images already exist." }),
  ),
  author: Type.Optional(
    Type.String({ description: "Displayed author name for the WeChat publish script." }),
  ),
  image_size: Type.Optional(
    Type.String({ description: "Image ratio for generated images. Default: 16:9." }),
  ),
  image_generator_script: Type.Optional(
    Type.String({ description: "Override path to the image generation script." }),
  ),
  image_api_key: Type.Optional(
    Type.String({ description: "Override image generation API key." }),
  ),
  wechat_publish_script: Type.Optional(
    Type.String({ description: "Override path to the WeChat publish.py script." }),
  ),

  // XiaoHongShu-specific fields
  title: Type.Optional(
    Type.String({ description: "Title for XiaoHongShu / Douyin note." }),
  ),
  description: Type.Optional(
    Type.String({ description: "Description text for XiaoHongShu / Douyin note." }),
  ),
  image_paths: Type.Optional(
    Type.Array(Type.String(), { description: "Image file paths for XiaoHongShu note." }),
  ),
  cookie: Type.Optional(
    Type.String({ description: "Platform cookie string. Falls back to stored cookie or env." }),
  ),
  is_private: Type.Optional(
    Type.Boolean({ description: "Publish as private. Default: true (safety first)." }),
  ),
  post_time: Type.Optional(
    Type.String({ description: "Scheduled post time (e.g. '2026-04-05 10:00')." }),
  ),

  // Douyin-specific fields
  video_path: Type.Optional(
    Type.String({ description: "Video file path for Douyin publish." }),
  ),
});

function resolveDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

async function resolveArticlePath(params: Record<string, unknown>): Promise<string | null> {
  const articlePath = params.article_path as string | undefined;
  if (articlePath) {
    return path.resolve(articlePath);
  }

  const contentId = params.content_id as string | undefined;
  if (!contentId) {
    return null;
  }

  const dataDir = resolveDataDir((params._dataDir as string) || undefined);
  const content = await getContent(contentId, dataDir);
  if (!content) {
    return null;
  }

  return path.join(dataDir, "contents", content.id, "draft.md");
}

async function executeWechatMpDraft(params: Record<string, unknown>) {
  const articlePath = await resolveArticlePath(params);
  if (!articlePath) {
    return { ok: false, error: "article_path or content_id is required" };
  }

  return publishWechatMpDraft({
    articlePath,
    theme: (params.theme as string) || "newspaper",
    dryRun: Boolean(params.dry_run),
    skipImages: Boolean(params.skip_images),
    author: (params.author as string) || "Lawrence",
    imageSize: (params.image_size as string) || "16:9",
    imageGeneratorScript: (params.image_generator_script as string) || undefined,
    imageApiKey: (params.image_api_key as string) || undefined,
    wechatPublishScript: (params.wechat_publish_script as string) || undefined,
  });
}

async function executeXiaohongshuPublish(params: Record<string, unknown>) {
  const title = params.title as string | undefined;
  const description = params.description as string | undefined;
  const imagePaths = params.image_paths as string[] | undefined;

  if (!title || !description) {
    return { ok: false, error: "title and description are required for xiaohongshu_publish" };
  }

  if (!imagePaths || imagePaths.length === 0) {
    return { ok: false, error: "image_paths (at least one image) is required for xiaohongshu_publish" };
  }

  let cookie = params.cookie as string | undefined;
  if (!cookie) {
    cookie = (await loadCookie("xiaohongshu")) ?? undefined;
  }

  return publishToXiaohongshu({
    title,
    description,
    imagePaths,
    cookie,
    isPrivate: params.is_private !== false,
    postTime: (params.post_time as string) || undefined,
    dryRun: Boolean(params.dry_run),
  });
}

async function executeDouyinPublish(params: Record<string, unknown>) {
  return publishToDouyin({
    title: (params.title as string) || "",
    description: (params.description as string) || "",
    videoPath: (params.video_path as string) || undefined,
    imagePaths: (params.image_paths as string[]) || undefined,
    isPrivate: params.is_private !== false,
    postTime: (params.post_time as string) || undefined,
  });
}

export async function executePublish(params: Record<string, unknown>) {
  const action = params.action as string;

  switch (action) {
    case "wechat_mp_draft":
      return executeWechatMpDraft(params);

    case "xiaohongshu_publish":
      return executeXiaohongshuPublish(params);

    case "douyin_publish":
      return executeDouyinPublish(params);

    case "relay_publish":
      return {
        ok: false,
        error:
          "relay_publish is experimental. Chrome Relay via OpenClaw Gateway is for research only, not publishing. Use platform-specific API publishers instead.",
      };

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}
