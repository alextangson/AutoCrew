import { Type } from "@sinclair/typebox";
import { saveTopic, listTopics, getTopic, listContents, softDeleteTopic } from "../storage/local-store.js";
import { prepareRadarPool, scoreRadarPool } from "../modules/radar/radar-host.js";

/**
 * Core tool logic — platform-agnostic.
 * Wrapped by index.ts (OpenClaw) and mcp/server.ts (Claude Code).
 */

export const topicCreateSchema = Type.Object({
  action: Type.Unsafe<"create" | "list" | "radar_pool" | "radar_score" | "delete">({
    type: "string",
    enum: ["create", "list", "radar_pool", "radar_score", "delete"],
    description:
      "Action: 'create' to save a new topic, 'list' to show all topics, " +
      "'radar_pool' to freeze today's radar candidate pool for you to score, " +
      "'radar_score' to submit your scores for a frozen pool (saves ≥70, max 3; safe to retry with the same results), " +
      "'delete' to move a topic to the recycle bin (needs id; refused while the topic still has drafts).",
  }),
  title: Type.Optional(Type.String({ description: "Topic title (required for create)" })),
  description: Type.Optional(Type.String({ description: "Topic description (required for create)" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Topic tags (required for create)" })),
  source: Type.Optional(Type.String({ description: "Where this topic idea came from" })),
  id: Type.Optional(Type.String({ description: "delete: topic id" })),
  pool_id: Type.Optional(Type.String({ description: "radar_score: pool_id returned by radar_pool" })),
  results: Type.Optional(
    Type.Array(
      Type.Object({
        candidate_id: Type.String({ description: "candidate_id from the pool" }),
        score: Type.Number({ description: "0-100, sum of the four rubric dimensions" }),
        title: Type.Optional(Type.String({ description: "Required when score ≥70: natural Chinese topic title" })),
        summary: Type.Optional(Type.String({ description: "Required when score ≥70: Chinese factual summary" })),
        angle: Type.Optional(Type.String({ description: "Required when score ≥70: one writable Chinese angle" })),
      }),
      { description: "radar_score: only candidates you actually scored; unscored ones are left untouched" },
    ),
  ),
});

export async function executeTopicCreate(params: Record<string, unknown>) {
  const action = (params.action as string) || "create";
  const dataDir = (params._dataDir as string) || undefined;

  if (action === "list") {
    const topics = await listTopics(dataDir);
    if (topics.length === 0) {
      return { ok: true, message: "No topics yet.", topics: [] };
    }
    return { ok: true, topics };
  }

  if (action === "delete") return deleteTopic(String(params.id ?? "").trim(), dataDir);

  // 雷达打分 host-first(P6 §3.2):池由产品建,分由宿主打,入库由产品按收据做
  if (action === "radar_pool") return prepareRadarPool(dataDir);
  if (action === "radar_score") return scoreRadarPool({ poolId: params.pool_id, results: params.results }, dataDir);

  // create
  const title = params.title as string;
  const description = params.description as string;
  const tags = (params.tags as string[]) || [];

  if (!title || !description) {
    return { ok: false, error: "title and description are required for create" };
  }

  const topic = await saveTopic({
    title,
    description,
    tags,
    source: (params.source as string) || undefined,
  }, dataDir);

  return { ok: true, topic };
}

/**
 * 删选题（移入回收站，可恢复）。选题下还有稿件就拒绝并列出来：先处理稿件，血缘不能悬空。
 * 本机 agent 调用时还要先过总编辑的执行前审批（chief-editor/publish-gate.ts）。
 */
async function deleteTopic(id: string, dataDir?: string) {
  if (!id) return { ok: false, error: "id is required for delete" };
  const topic = await getTopic(id, dataDir);
  if (!topic || topic.deletedAt) return { ok: false, error: `Topic ${id} not found` };
  const drafts = (await listContents(dataDir)).filter((c) => c.topicId === id);
  if (drafts.length > 0) {
    return {
      ok: false,
      code: "topic_has_drafts",
      error: `选题《${topic.title}》下还有 ${drafts.length} 篇稿件，先处理稿件再删选题：${drafts.map((c) => `《${c.title}》(${c.id})`).join("、")}`,
      drafts: drafts.map((c) => ({ id: c.id, title: c.title, status: c.status })),
    };
  }
  const deleted = await softDeleteTopic(id, dataDir);
  return deleted ? { ok: true, message: `选题《${topic.title}》已移入回收站（可恢复）`, topic: { id: deleted.id, title: deleted.title } } : { ok: false, error: `Topic ${id} not found` };
}
