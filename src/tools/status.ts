import { Type } from "@sinclair/typebox";
import { listTopics, listContents } from "../storage/local-store.js";

export const statusSchema = Type.Object({
  verbose: Type.Optional(Type.Boolean({ description: "Show detailed counts" })),
});

export async function executeStatus(params: Record<string, unknown>) {
  const dataDir = (params._dataDir as string) || undefined;

  const topics = await listTopics(dataDir);
  const contents = await listContents(dataDir);

  const byStatus = {
    draft: contents.filter((c) => c.status === "draft").length,
    review: contents.filter((c) => c.status === "review").length,
    approved: contents.filter((c) => c.status === "approved").length,
    published: contents.filter((c) => c.status === "published").length,
  };

  return {
    ok: true,
    version: "0.1.0",
    topics: topics.length,
    contents: contents.length,
    contentsByStatus: byStatus,
    latestTopic: topics[0]?.title || null,
    latestContent: contents[0]?.title || null,
  };
}
