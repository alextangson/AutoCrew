import { Type } from "@sinclair/typebox";
import { getContent, saveContent, updateContent } from "../storage/local-store.js";
import { adaptPlatformDraft, type SupportedPlatform } from "../modules/writing/platform-rewrite.js";
import { generateForPlatform } from "../modules/writing/title-hashtag.js";

export const rewriteSchema = Type.Object({
  action: Type.Unsafe<"adapt_platform" | "batch_adapt">({
    type: "string",
    enum: ["adapt_platform", "batch_adapt"],
    description:
      "Action. 'adapt_platform' adapts to one platform, 'batch_adapt' adapts to multiple platforms at once.",
  }),
  content_id: Type.Optional(Type.String({ description: "Existing AutoCrew content id to adapt." })),
  title: Type.Optional(Type.String({ description: "Source title when adapting raw text directly." })),
  body: Type.Optional(Type.String({ description: "Source body when adapting raw text directly." })),
  tags: Type.Optional(Type.Array(Type.String({ description: "Optional tags" }))),
  target_platform: Type.Optional(
    Type.Unsafe<"xiaohongshu" | "douyin" | "wechat_mp" | "wechat_video" | "bilibili">({
      type: "string",
      enum: ["xiaohongshu", "douyin", "wechat_mp", "wechat_video", "bilibili"],
      description: "Target platform for adapt_platform action.",
    }),
  ),
  target_platforms: Type.Optional(
    Type.Array(
      Type.Unsafe<"xiaohongshu" | "douyin" | "wechat_mp" | "wechat_video" | "bilibili">({
        type: "string",
        enum: ["xiaohongshu", "douyin", "wechat_mp", "wechat_video", "bilibili"],
      }),
      { description: "Target platforms for batch_adapt action." },
    ),
  ),
  save_as_draft: Type.Optional(Type.Boolean({ description: "Save the adapted result as a new AutoCrew draft." })),
});

/**
 * Resolve source content from params (content_id or raw title+body).
 */
async function resolveSource(params: Record<string, unknown>) {
  const dataDir = (params._dataDir as string) || undefined;
  let title = (params.title as string) || "";
  let body = (params.body as string) || "";
  let tags = (params.tags as string[]) || [];
  const contentId = params.content_id as string | undefined;
  let topicId: string | undefined;

  if (contentId) {
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false as const, error: `Content ${contentId} not found` };
    title = content.title;
    body = content.body;
    tags = content.tags || tags;
    topicId = content.topicId;
  }

  if (!title || !body) return { ok: false as const, error: "content_id or title + body is required" };

  return { ok: true as const, title, body, tags, contentId, topicId, dataDir };
}

/**
 * Adapt a single platform: rewrite + generate title/hashtag + optionally save.
 */
async function adaptOne(
  title: string,
  body: string,
  tags: string[],
  platform: SupportedPlatform,
  opts: { saveAsDraft?: boolean; topicId?: string; siblingIds?: string[]; dataDir?: string },
) {
  const adapted = adaptPlatformDraft({ title, body, tags, targetPlatform: platform });

  // Generate title variants + hashtags
  const titleResult = generateForPlatform(adapted.title, platform, { tags });
  const hashtags = titleResult.hashtags.map((h) => h.tag);

  const result: Record<string, unknown> = {
    ...adapted,
    titleVariants: titleResult.titles,
    hashtags,
  };

  if (opts.saveAsDraft) {
    const saved = await saveContent(
      {
        title: adapted.title,
        body: adapted.body,
        platform: adapted.platform,
        status: "draft",
        tags,
        hashtags,
        topicId: opts.topicId,
        siblings: opts.siblingIds || [],
      } as any,
      opts.dataDir,
    );
    result.content = saved;
  }

  return result;
}

export async function executeRewrite(params: Record<string, unknown>) {
  const action = params.action as string;

  // --- adapt_platform (single) ---
  if (action === "adapt_platform") {
    const src = await resolveSource(params);
    if (!src.ok) return src;

    const platform = params.target_platform as SupportedPlatform;
    if (!platform) return { ok: false, error: "target_platform is required for adapt_platform" };

    return adaptOne(src.title, src.body, src.tags, platform, {
      saveAsDraft: Boolean(params.save_as_draft),
      topicId: src.topicId,
      dataDir: src.dataDir,
    });
  }

  // --- batch_adapt (multiple platforms) ---
  if (action === "batch_adapt") {
    const src = await resolveSource(params);
    if (!src.ok) return src;

    const platforms = params.target_platforms as SupportedPlatform[] | undefined;
    if (!platforms || platforms.length === 0) {
      return { ok: false, error: "target_platforms is required for batch_adapt" };
    }

    const results: Record<string, unknown>[] = [];
    const savedIds: string[] = [];

    for (const platform of platforms) {
      const result = await adaptOne(src.title, src.body, src.tags, platform, {
        saveAsDraft: Boolean(params.save_as_draft),
        topicId: src.topicId,
        dataDir: src.dataDir,
      });
      results.push(result);
      const savedContent = result.content as { id: string } | undefined;
      if (savedContent?.id) savedIds.push(savedContent.id);
    }

    // Build sibling relationships among all saved drafts (+ source if it exists)
    if (params.save_as_draft && savedIds.length > 1) {
      const allIds = src.contentId ? [src.contentId, ...savedIds] : savedIds;
      for (const id of allIds) {
        const siblingIds = allIds.filter((s) => s !== id);
        await updateContent(id, { siblings: siblingIds }, src.dataDir);
      }
    }

    return {
      ok: true,
      action: "batch_adapt",
      sourceContentId: src.contentId || null,
      platforms: platforms,
      results,
      siblingIds: savedIds,
    };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}
