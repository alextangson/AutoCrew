import { Type } from "@sinclair/typebox";
import {
  saveContent,
  listContents,
  getContent,
  updateContent,
  transitionStatus,
  createPlatformVariant,
  listSiblings,
  getAllowedTransitions,
  normalizeLegacyStatus,
  recordAdoption,
  adoptionStats,
  softDeleteContent,
  restoreContent,
} from "../storage/local-store.js";
import type { AdoptionVerdict } from "../storage/local-store.js";
import { recordDiff } from "../modules/learnings/diff-tracker.js";
import { shouldDistillStyle, distillStyleRules } from "../modules/learnings/style-distiller.js";
import type { StyleDistillResult } from "../modules/learnings/style-distiller.js";
import type { Content } from "../storage/local-store.js";

const ALL_STATUSES = [
  "topic_saved", "drafting", "draft_ready", "reviewing", "revision",
  "approved", "cover_pending", "publish_ready", "publishing", "published", "archived",
  // Legacy compat
  "draft", "review",
] as const;

export const contentSaveSchema = Type.Object({
  action: Type.Unsafe<"save" | "list" | "get" | "update" | "transition" | "create_variant" | "siblings" | "allowed_transitions" | "adoption" | "delete" | "restore">({
    type: "string",
    enum: ["save", "list", "get", "update", "transition", "create_variant", "siblings", "allowed_transitions", "adoption", "delete", "restore"],
    description:
      "Action: 'save' new content, 'list' all, 'get' by id, 'update' existing, " +
      "'transition' change status via state machine, 'create_variant' create platform variant from topic, " +
      "'siblings' list sibling content, 'allowed_transitions' show valid next statuses, " +
      "'adoption' record adoption verdict (采纳率北极星读数).",
  }),
  id: Type.Optional(Type.String({ description: "Content id (for get/update/transition/siblings/allowed_transitions)" })),
  title: Type.Optional(Type.String({ description: "Content title" })),
  body: Type.Optional(Type.String({ description: "Content body (markdown)" })),
  platform: Type.Optional(Type.String({ description: "Target platform: xhs, douyin, wechat_video, wechat_mp, bilibili" })),
  topicId: Type.Optional(Type.String({ description: "Related topic id (for save/create_variant)" })),
  status: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ALL_STATUSES as unknown as string[],
    description: "Content status (for save/update). Use 'transition' action for validated state changes.",
  })),
  target_status: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ALL_STATUSES as unknown as string[],
    description: "Target status for 'transition' action.",
  })),
  tags: Type.Optional(Type.Array(Type.String())),
  hashtags: Type.Optional(Type.Array(Type.String(), { description: "Platform-specific hashtags" })),
  siblings: Type.Optional(Type.Array(Type.String(), { description: "Sibling content IDs" })),
  publish_url: Type.Optional(Type.String({ description: "Published URL on target platform" })),
  performance_data: Type.Optional(Type.Record(Type.String(), Type.Number(), { description: "Performance metrics: views, likes, comments, shares, etc." })),
  force: Type.Optional(Type.Boolean({ description: "Force transition even if not in allowed transitions" })),
  diff_note: Type.Optional(Type.String({ description: "Note for revision diff tracking" })),
  verdict: Type.Optional(Type.Unsafe<AdoptionVerdict>({
    type: "string",
    enum: ["adopted", "light_edit", "rewritten"],
    description: "Adoption verdict for 'adoption' action: adopted 直接采纳 | light_edit 轻改采纳 | rewritten 推倒重写.",
  })),
});

/**
 * Build the updates object including ONLY fields actually provided.
 * Explicit undefined keys would otherwise survive local-store's
 * `{...existing, ...updates}` spread and destroy existing values.
 */
function buildContentUpdates(params: Record<string, unknown>): Partial<Content> {
  const updates: Partial<Content> = {};
  if (params.title !== undefined) updates.title = params.title as string;
  if (params.body !== undefined) updates.body = params.body as string;
  if (params.platform !== undefined) updates.platform = params.platform as string;
  if (params.status) updates.status = normalizeLegacyStatus(params.status as string);
  if (params.tags !== undefined) updates.tags = params.tags as string[];
  if (params.hashtags !== undefined) updates.hashtags = params.hashtags as string[];
  if (params.siblings !== undefined) updates.siblings = params.siblings as string[];
  if (params.publish_url !== undefined) updates.publishUrl = params.publish_url as string;
  if (params.performance_data !== undefined) {
    updates.performanceData = params.performance_data as Record<string, number>;
  }
  return updates;
}

export async function executeContentSave(
  params: Record<string, unknown>,
  deps?: {
    recordDiffImpl?: typeof recordDiff;
    shouldDistillImpl?: typeof shouldDistillStyle;
    distillImpl?: typeof distillStyleRules;
  },
) {
  const action = (params.action as string) || "save";
  const dataDir = (params._dataDir as string) || undefined;
  const recordDiffImpl = deps?.recordDiffImpl || recordDiff;
  const shouldDistillImpl = deps?.shouldDistillImpl || shouldDistillStyle;
  const distillImpl = deps?.distillImpl || distillStyleRules;

  if (action === "list") {
    const contents = await listContents(dataDir);
    return { ok: true, contents };
  }

  if (action === "get") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for get" };
    const content = await getContent(id, dataDir);
    if (!content) return { ok: false, error: `Content ${id} not found` };
    return { ok: true, content };
  }

  if (action === "update") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for update" };

    // Get old content before update to check for body changes
    const oldContent = await getContent(id, dataDir);
    if (!oldContent) return { ok: false, error: `Content ${id} not found` };
    const oldBody = oldContent.body;
    const newBody = params.body as string | undefined;

    const updated = await updateContent(id, buildContentUpdates(params), dataDir);
    if (!updated) return { ok: false, error: `Content ${id} not found` };

    // Record diff if body changed
    let styleLearned: StyleDistillResult | undefined;
    if (newBody && newBody !== oldBody) {
      try {
        await recordDiffImpl(id, "body", oldBody, newBody, dataDir, params.diff_note as string | undefined, oldContent.platform);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          ok: true,
          content: updated,
          warning: `diff 记录失败：${errorMsg}，稿件已正常保存`,
        };
      }

      // Auto-distill style rules once enough edits accumulate. Best-effort:
      // a missing model provider or any distill error must never fail the save —
      // the user's edit is already persisted.
      try {
        if (await shouldDistillImpl(dataDir)) {
          styleLearned = await distillImpl(dataDir);
        }
      } catch {
        /* distill is best-effort; the edit is saved regardless */
      }
    }

    return styleLearned
      ? { ok: true, content: updated, styleLearned }
      : { ok: true, content: updated };
  }

  if (action === "delete") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for delete" };
    const deleted = await softDeleteContent(id, dataDir);
    if (!deleted) return { ok: false, error: `Content ${id} not found` };
    return { ok: true, content: deleted };
  }

  if (action === "restore") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for restore" };
    const restored = await restoreContent(id, dataDir);
    if (!restored) return { ok: false, error: `Content ${id} not found` };
    return { ok: true, content: restored };
  }

  if (action === "adoption") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for adoption" };
    const verdict = params.verdict as AdoptionVerdict | undefined;
    if (verdict !== "adopted" && verdict !== "light_edit" && verdict !== "rewritten") {
      return { ok: false, error: "verdict must be one of: adopted | light_edit | rewritten" };
    }
    const updated = await recordAdoption(id, verdict, dataDir);
    if (!updated) return { ok: false, error: `Content ${id} not found` };
    // 附带全局采纳率：UI toast 直接可见北极星读数（白盒资格线的一部分）
    const stats = await adoptionStats(dataDir);
    return { ok: true, content: updated, stats };
  }

  if (action === "transition") {
    const id = params.id as string;
    const targetStatus = params.target_status as string;
    if (!id) return { ok: false, error: "id is required for transition" };
    if (!targetStatus) return { ok: false, error: "target_status is required for transition" };
    const result = await transitionStatus(
      id,
      normalizeLegacyStatus(targetStatus),
      { force: params.force as boolean, diffNote: params.diff_note as string },
      dataDir,
    );
    return result;
  }

  if (action === "create_variant") {
    const topicId = params.topicId as string;
    const platform = params.platform as string;
    if (!topicId) return { ok: false, error: "topicId is required for create_variant" };
    if (!platform) return { ok: false, error: "platform is required for create_variant" };
    const result = await createPlatformVariant(
      topicId,
      platform,
      { title: params.title as string, body: params.body as string },
      dataDir,
    );
    return result;
  }

  if (action === "siblings") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for siblings" };
    const sibs = await listSiblings(id, dataDir);
    return { ok: true, siblings: sibs };
  }

  if (action === "allowed_transitions") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for allowed_transitions" };
    const content = await getContent(id, dataDir);
    if (!content) return { ok: false, error: `Content ${id} not found` };
    const currentStatus = normalizeLegacyStatus(content.status);
    const allowed = getAllowedTransitions(currentStatus);
    return { ok: true, currentStatus, allowedTransitions: allowed };
  }

  // save
  const title = params.title as string;
  const body = params.body as string;
  if (!title || !body) {
    return { ok: false, error: "title and body are required for save" };
  }

  const rawStatus = (params.status as string) || "draft_ready";
  const content = await saveContent({
    title,
    body,
    platform: (params.platform as string) || undefined,
    topicId: (params.topicId as string) || undefined,
    status: normalizeLegacyStatus(rawStatus),
    tags: (params.tags as string[]) || [],
    hashtags: (params.hashtags as string[]) || [],
  }, dataDir);

  return { ok: true, content };
}
