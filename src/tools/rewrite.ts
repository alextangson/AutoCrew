import { Type } from "@sinclair/typebox";
import { getContent, saveContent, updateContent } from "../storage/local-store.js";
import { type SupportedPlatform } from "../modules/writing/platform-rewrite.js";
import { adaptPlatformLLM } from "../modules/writing/platform-adapt-llm.js";
import { generateHashtags } from "../modules/writing/title-hashtag.js";
import { titleMethodGuide } from "../modules/writing/title-methods.js";
import { activeTitleMethods } from "../modules/calibration/title-library.js";
import { provenanceOf, type WriteProvenance } from "../storage/first-body-guard.js";
import { aiContentWriteRefusal, newDraftAngleRefusal } from "../modules/research/angle-gate.js";

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
  execution: Type.Optional(Type.Literal("engine", { description: "仅用户明确要求后台模型提供适配建议时使用。正式稿仍需writer提交。" })),
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
  // 模型发起的改写/多平台适配在调模型之前就过选题会判定（admission）：源稿是真稿放行，
  // 占位稿 = 在给选题开第一篇；裸文本要存成稿必然没有选题。落盘时存储层的卡口还会再判一次。
  const declared = provenanceOf(params);
  // 由已有稿改写：把源稿 id 一起交给存储层卡口，它会严格读源稿确认是真稿（新稿没挂选题也能放行）
  const provenance = declared?.kind === "model" && contentId ? { ...declared, derivedFrom: contentId } : declared;
  if (provenance?.kind === "model") {
    const refused = contentId ? await aiContentWriteRefusal(contentId, dataDir)
      : params.save_as_draft ? await newDraftAngleRefusal(undefined, dataDir) : null;
    if (refused) return refused;
  }
  return { ok: true as const, title, body, tags, contentId, topicId, dataDir, provenance };
}

/**
 * Adapt a single platform: rewrite + title method guide + hashtags + optionally save.
 */
async function adaptOne(
  title: string,
  body: string,
  tags: string[],
  platform: SupportedPlatform,
  opts: { saveAsDraft?: boolean; topicId?: string; siblingIds?: string[]; dataDir?: string; provenance: WriteProvenance | undefined },
) {
  // LLM 按平台腔调重写(X 偏观点、小红书体验流…);引擎不可用自动落回机械兜底。
  const adapted = await adaptPlatformLLM(title, body, tags, platform, opts.dataDir);

  // 标题不再由代码拼：返回方法库指引，由宿主按方法写；标签仍按平台规则给建议
  const hashtags = generateHashtags(adapted.title, platform, tags).map((h) => h.tag);

  const result: Record<string, unknown> = {
    ...adapted,
    titleGuide: titleMethodGuide(platform, await activeTitleMethods(opts.dataDir)),
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
        _provenance: opts.provenance,
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
      provenance: src.provenance,
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
        provenance: src.provenance,
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


/** MCP/OpenClaw 入口：不能让旧适配工具绕过宿主写作、证据与审稿。GUI内部调用保留。 */
export async function executeHostRewrite(params: Record<string, unknown>) {
  if (params.execution !== "engine" || params.save_as_draft === true) {
    return {
      ok: false, code: "writer_submission_required",
      error: "平台改写也需由宿主按prepare/pack/submit完成。后台适配仅在用户明确要求execution=engine时提供未审建议，不能直接保存为正式稿。",
      next_action: { tool: "autocrew_workflow", action: "prepare", message: "读取原稿，保留事实和声音；按目标平台独立prepare，原稿可作为research_mode=provided材料，再经writer交稿。" },
    };
  }
  const result = await executeRewrite(params);
  if (result.ok === false) return result;
  return { ...result, saved: false, quality_status: "unreviewed", needs_attention: true, note: "后台适配建议尚未经过完整审稿。正式保存需经writer submit；不能把建议伪装成人工导入。" };
}
