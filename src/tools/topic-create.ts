import { Type } from "@sinclair/typebox";
import { saveTopic as legacySaveTopic, listTopics as legacyListTopics } from "../storage/local-store.js";
import {
  saveTopic as pipelineSaveTopic,
  listTopics as pipelineListTopics,
  type TopicCandidate,
} from "../storage/pipeline-store.js";

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
    // List from both stores, deduplicate by title
    const legacyTopics = await legacyListTopics(dataDir);
    const pipelineTopics = await pipelineListTopics(undefined, dataDir);

    const combined = [
      ...legacyTopics.map((t) => ({ ...t, _store: "legacy" })),
      ...pipelineTopics.map((t) => ({ title: t.title, domain: t.domain, tags: t.tags || [], score: t.score, _store: "pipeline" })),
    ];

    if (combined.length === 0) {
      return { ok: true, message: "No topics yet.", topics: [] };
    }
    return { ok: true, topics: combined };
  }

  // create — write to BOTH stores for compatibility
  const title = params.title as string;
  const description = params.description as string;
  const tags = (params.tags as string[]) || [];

  if (!title || !description) {
    return { ok: false, error: "title and description are required for create" };
  }

  // Save to legacy store (for backward compat)
  const legacyTopic = await legacySaveTopic({
    title,
    description,
    tags,
    source: (params.source as string) || undefined,
  }, dataDir);

  // Also save to pipeline store (so start command finds it)
  const now = new Date().toISOString();
  const pipelineTopic: TopicCandidate = {
    title,
    domain: tags[0] || "general",
    score: { heat: 50, differentiation: 50, audienceFit: 50, overall: 50 },
    formats: [],
    suggestedPlatforms: [],
    createdAt: now,
    intelRefs: [],
    angles: [description],
    audienceResonance: "",
    references: [],
  };
  await pipelineSaveTopic(pipelineTopic, dataDir);

  return { ok: true, topic: legacyTopic, pipelineSynced: true };
}
