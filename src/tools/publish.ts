import path from "node:path";
import { Type } from "@sinclair/typebox";
import { getContent } from "../storage/local-store.js";
import { publishWechatMpDraft } from "../modules/publish/wechat-mp.js";

export const publishSchema = Type.Object({
  action: Type.Unsafe<"wechat_mp_draft">({
    type: "string",
    enum: ["wechat_mp_draft"],
    description: "Publish action. Currently supported: 'wechat_mp_draft'.",
  }),
  article_path: Type.Optional(Type.String({ description: "Absolute or relative path to the markdown article file." })),
  content_id: Type.Optional(Type.String({ description: "AutoCrew content id. If provided, draft.md will be used." })),
  theme: Type.Optional(Type.String({ description: "WeChat formatting theme. Default: newspaper." })),
  dry_run: Type.Optional(Type.Boolean({ description: "Generate assets and show the publish command without pushing." })),
  skip_images: Type.Optional(Type.Boolean({ description: "Skip image generation if images already exist." })),
  author: Type.Optional(Type.String({ description: "Displayed author name for the WeChat publish script." })),
  image_size: Type.Optional(Type.String({ description: "Image ratio for generated images. Default: 16:9." })),
  image_generator_script: Type.Optional(Type.String({ description: "Override path to the image generation script." })),
  image_api_key: Type.Optional(Type.String({ description: "Override image generation API key." })),
  wechat_publish_script: Type.Optional(Type.String({ description: "Override path to the WeChat publish.py script." })),
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

export async function executePublish(params: Record<string, unknown>) {
  const action = params.action as string;
  if (action !== "wechat_mp_draft") {
    return { ok: false, error: `Unknown action: ${action}` };
  }

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
