import path from "node:path";
import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { getContent, updateContent, getDataDir, getCoverReview } from "../storage/local-store.js";
import { publishWechatMpDraft } from "../modules/publish/wechat-mp.js";
import { loadWechatMpConfig } from "../modules/publish/wechat-config.js";
import { formatForClipboard, type ClipboardPlatform } from "../modules/publish/clipboard-publisher.js";
import { VIDEO_PLATFORMS } from "../modules/publish/video-kit.js";
import { preparedArticleImages } from "../modules/publish/article-images.js";
import { scanText } from "../modules/filter/sensitive-words.js";
import { generateAndSaveDigest } from "../modules/publish/digest.js";

export const publishSchema = Type.Object({
  action: Type.Unsafe<"wechat_mp_draft" | "clipboard" | "confirm_published" | "digest">({
    type: "string",
    enum: ["wechat_mp_draft", "clipboard", "confirm_published", "digest"],
    description: "Publish action. 'wechat_mp_draft' for WeChat MP, 'clipboard' for copy-paste, 'confirm_published' to mark published, 'digest' to generate+save a ≤20-char WeChat 摘要.",
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
  image_base_url: Type.Optional(Type.String({ description: "OpenAI-compatible relay base URL for image generation (must pair with the api key)." })),
  image_model: Type.Optional(Type.String({ description: "Image model id, e.g. gpt-image-2 for relays. Default: script's built-in (doubao-seedream)." })),
  wechat_publish_script: Type.Optional(Type.String({ description: "Override path to the WeChat publish.py script." })),
  hashtags: Type.Optional(Type.Array(Type.String(), { description: "Hashtags for the content. Overrides content hashtags if provided." })),
  publish_url: Type.Optional(Type.String({ description: "The URL where content was published (for confirm_published action)." })),
  force: Type.Optional(Type.Boolean({ description: "Bypass the pre-publish checklist gate. Use only when the user explicitly insists." })),
  digest: Type.Optional(Type.String({ description: "For 'digest' action: manual 摘要 to save (empty clears it). Omit to AI-generate." })),
});

export async function executePublish(
  params: Record<string, unknown>,
  deps?: { publishImpl?: typeof publishWechatMpDraft },
) {
  const action = params.action as string;
  // getDataDir 统一解析(session-8 收编私有副本的第七处漏网):认 AUTOCREW_DATA_DIR 重定向,
  // 否则隔离工作区/smoke 里 clipboard 会去真实 ~/.autocrew 找稿件
  const dataDir = getDataDir((params._dataDir as string) || undefined);

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
    // V5.4b:视频平台有发布件 → 发的是发布件(平台标题+发布文案,已含标签),不是口播稿截断
    if (content.videoKit?.caption && VIDEO_PLATFORMS.has(platform)) {
      const kit = content.videoKit;
      const output = formatForClipboard(platform, kit.postTitle || content.title, kit.caption, []);
      return { ok: true, data: { ...output, fromVideoKit: true } };
    }
    const output = formatForClipboard(platform, content.title, content.body, hashtags);
    return { ok: true, data: output };
  }

  // --- digest: 生成(默认) 或 手动保存(带 digest 参数) 一条 ≤20 字公众号摘要 ---
  if (action === "digest") {
    const contentId = params.content_id as string | undefined;
    if (!contentId) return { ok: false, error: "content_id is required for digest action" };
    const manual = typeof params.digest === "string" ? params.digest.trim().slice(0, 40) : undefined;
    try {
      if (manual !== undefined) {
        const updated = await updateContent(contentId, { digest: manual }, dataDir);
        if (!updated) return { ok: false, error: `Content not found: ${contentId}` };
        return { ok: true, data: { digest: manual } };
      }
      const { digest } = await generateAndSaveDigest(contentId, dataDir);
      return { ok: true, data: { digest } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
  let preparedImages: string[] | undefined;
  let digest: string | undefined;

  if (contentId) {
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, error: `Content not found: ${contentId}` };
    // 发布时从 store 新鲜落盘 draft.md——工作台编辑只更新 store，旧 draft.md 不得被推送
    articlePath = path.join(dataDir, "contents", content.id, "draft.md");
    await fs.writeFile(articlePath, `# ${content.title}\n\n${content.body}\n`, "utf-8");
    gateText = `${content.title}\n\n${content.body}`;
    digest = content.digest;
    const bodyImages = await preparedArticleImages(contentId, dataDir);
    if (!bodyImages.ok) return bodyImages;
    preparedImages = bodyImages.paths;
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

  // 封面设计师接线:有选用封面(approvedImagePath,公众号即 2.35:1 精裁图)就推它,
  // 不再让脚本拿"文中第一图"当封面——设计师转正了,活儿要上岗
  let approvedCover: string | undefined;
  if (contentId) {
    const review = await getCoverReview(contentId, dataDir).catch(() => null);
    const p = review?.approvedImagePath;
    if (p) {
      try {
        await fs.access(p);
        approvedCover = p;
      } catch {
        /* 选用图文件丢失 → 维持脚本兜底 */
      }
    }
  }

  const cfg = await loadWechatMpConfig(dataDir);
  const result = await publishImpl({
    articlePath,
    coverPath: approvedCover,
    wechatAppId: cfg.wechatAppId,
    wechatAppSecret: cfg.wechatAppSecret,
    openComment: cfg.openComment,
    theme: (params.theme as string) || cfg.theme || "newspaper",
    dryRun: Boolean(params.dry_run),
    skipImages: Boolean(params.skip_images),
    author: (params.author as string) || cfg.author || "Lawrence",
    imageSize: (params.image_size as string) || "16:9",
    imageGeneratorScript: (params.image_generator_script as string) || cfg.imageGeneratorScript,
    imageApiKey: (params.image_api_key as string) || cfg.imageApiKey,
    imageBaseUrl: (params.image_base_url as string) || cfg.imageBaseUrl,
    imageModel: (params.image_model as string) || cfg.imageModel,
    wechatPublishScript: (params.wechat_publish_script as string) || cfg.wechatPublishScript,
    apiProxy: (params.api_proxy as string) || cfg.apiProxy,
    digest,
    preparedImages,
  });

  const receipt = result.ok
    ? { ...result, nextStep: "到公众号后台「草稿箱」检查排版后点击发表，发表后回到工作台点「确认已发布」" }
    : result;
  return violations.length > 0 ? { ...receipt, violations, warning: "force 推送：违禁词未清零" } : receipt;
}
