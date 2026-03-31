import { Type } from "@sinclair/typebox";
import { saveTopic, listTopics } from "../storage/local-store.js";

/**
 * Core tool logic — platform-agnostic.
 * Wrapped by index.ts (OpenClaw) and mcp/server.ts (Claude Code).
 */

export const topicCreateSchema = Type.Object({
  action: Type.Unsafe<"create" | "list">({
    type: "string",
    enum: ["create", "list"],
    description: "Action: 'create' to save a new topic, 'list' to show all topics.",
  }),
  title: Type.Optional(Type.String({ description: "Topic title (required for create)" })),
  description: Type.Optional(Type.String({ description: "Topic description (required for create)" })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Topic tags (required for create)" })),
  source: Type.Optional(Type.String({ description: "Where this topic idea came from" })),
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
