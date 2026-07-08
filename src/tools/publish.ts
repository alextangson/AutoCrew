import path from "node:path";
import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { getContent, updateContent } from "../storage/local-store.js";
import { publishWechatMpDraft } from "../modules/publish/wechat-mp.js";
import { loadWechatMpConfig } from "../modules/publish/wechat-config.js";
import { formatForClipboard, type ClipboardPlatform } from "../modules/publish/clipboard-publisher.js";
import { scanText } from "../modules/filter/sensitive-words.js";

export const publishSchema = Type.Object({
  action: Type.Unsafe<"wechat_mp_draft" | "clipboard" | "confirm_published">({
    type: "string",
    enum: ["wechat_mp_draft", "clipboard", "confirm_published"],
    description: "Publish action. 'wechat_mp_draft' for WeChat MP, 'clipboard' for copy-paste publishing, 'confirm_published' to mark content as published.",
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
  hashtags: Type.Optional(Type.Array(Type.String(), { description: "Hashtags for the content. Overrides content hashtags if provided." })),
  publish_url: Type.Optional(Type.String({ description: "The URL where content was published (for confirm_published action)." })),
  force: Type.Optional(Type.Boolean({ description: "Bypass the pre-publish checklist gate. Use only when the user explicitly insists." })),
});

function resolveDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

export async function executePublish(
  params: Record<string, unknown>,
  deps?: { publishImpl?: typeof publishWechatMpDraft },
) {
  const action = params.action as string;
  const dataDir = resolveDataDir((params._dataDir as string) || undefined);

  // --- clipboard: format content for manual copy-paste publishing ---
  if (action === "clipboard") {
    const contentId = params.content_id as string | undefined;
    if (!contentId) {
      return { ok: false, error: "content_id is required for clipboard action" };
    }
    const content = await getContent(contentId, dataDir);
    if (!content) {
      return { ok: false, error: `Content not found: ${contentId}` };
    }
    const platform = (content.platform || "xiaohongshu") as ClipboardPlatform;
    const hashtags = (params.hashtags as string[] | undefined) || content.hashtags || [];
    const output = formatForClipboard(platform, content.title, content.body, hashtags);
    return { ok: true, data: output };
  }

  // --- confirm_published: mark content as published after manual paste ---
  if (action === "confirm_published") {
    const contentId = params.content_id as string | undefined;
    if (!contentId) {
      return { ok: false, error: "content_id is required for confirm_published action" };
    }
    const content = await getContent(contentId, dataDir);
    if (!content) {
      return { ok: false, error: `Content not found: ${contentId}` };
    }
    const updated = await updateContent(contentId, {
      status: "published",
      publishedAt: new Date().toISOString(),
      publishUrl: (params.publish_url as string) || null,
    }, dataDir);
    if (!updated) {
      return { ok: false, error: `Failed to update content: ${contentId}` };
    }
    return { ok: true, data: { id: contentId, status: "published", publishedAt: updated.publishedAt } };
  }

  // --- wechat_mp_draft: A 级发布（P0 阶段 2）——store 为事实源 + 审核员发布门 ---
  if (action !== "wechat_mp_draft") {
    return { ok: false, error: `Unknown action: ${action}` };
  }

  const publishImpl = deps?.publishImpl ?? publishWechatMpDraft;
  const contentId = params.content_id as string | undefined;
  let articlePath: string;
  let gateText: string;

  if (contentId) {
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, error: `Content not found: ${contentId}` };
    // 发布时从 store 新鲜落盘 draft.md——工作台编辑只更新 store，旧 draft.md 不得被推送
    articlePath = path.join(dataDir, "contents", content.id, "draft.md");
    await fs.writeFile(articlePath, `# ${content.title}\n\n${content.body}\n`, "utf-8");
    gateText = `${content.title}\n\n${content.body}`;
  } else if (params.article_path) {
    articlePath = path.resolve(params.article_path as string);
    try {
      gateText = await fs.readFile(articlePath, "utf-8");
    } catch {
      return { ok: false, error: `Article not found: ${articlePath}` };
    }
  } else {
    return { ok: false, error: "article_path or content_id is required" };
  }

  // 审核员发布门（同步阻断）：违禁词未清零禁止推送；force 放行但违规照样透出——
  // 最终决定权在人，系统保持透明（禁止静默）
  const scan = await scanText(gateText, "wechat_mp", dataDir);
  const violations = scan.hits.map((h) => h.word);
  if (violations.length > 0 && !params.force) {
    return {
      ok: false,
      violations,
      error: `审核员阻断推送：命中违禁词「${violations.join("、")}」。修改后重试（或 force 强制推送，不建议）`,
    };
  }

  const cfg = await loadWechatMpConfig(dataDir);
  const result = await publishImpl({
    articlePath,
    theme: (params.theme as string) || cfg.theme || "newspaper",
    dryRun: Boolean(params.dry_run),
    skipImages: Boolean(params.skip_images),
    author: (params.author as string) || cfg.author || "Lawrence",
    imageSize: (params.image_size as string) || "16:9",
    imageGeneratorScript: (params.image_generator_script as string) || cfg.imageGeneratorScript,
    imageApiKey: (params.image_api_key as string) || cfg.imageApiKey,
    wechatPublishScript: (params.wechat_publish_script as string) || cfg.wechatPublishScript,
  });

  const receipt = result.ok
    ? { ...result, nextStep: "到公众号后台「草稿箱」检查排版后点击发表，发表后回到工作台点「确认已发布」" }
    : result;
  return violations.length > 0 ? { ...receipt, violations, warning: "force 推送：违禁词未清零" } : receipt;
}
