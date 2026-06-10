import { Type } from "@sinclair/typebox";
import { listTopics, listContents } from "../storage/local-store.js";
import { buildBaseline, compareToBaseline, trackPerformance } from "../modules/analytics/quality-baseline.js";
import { generateLearningReport } from "../modules/learnings/visible-learning.js";

export const statusSchema = Type.Object({
  action: Type.Optional(Type.Unsafe<"overview" | "baseline" | "compare" | "track_performance" | "learning_report">({
    type: "string",
    enum: ["overview", "baseline", "compare", "track_performance", "learning_report"],
    description:
      "Action: 'overview' (default) pipeline status, 'baseline' quality baseline from history, " +
      "'compare' compare content to baseline, 'track_performance' record metrics, 'learning_report' show learning progress.",
  })),
  verbose: Type.Optional(Type.Boolean({ description: "Show detailed counts" })),
  content_id: Type.Optional(Type.String({ description: "Content ID for compare/track_performance." })),
  metrics: Type.Optional(Type.Record(Type.String(), Type.Number(), {
    description: "Performance metrics for track_performance: views, likes, comments, shares, saves.",
  })),
});

export async function executeStatus(params: Record<string, unknown>) {
  const action = (params.action as string) || "overview";
  const dataDir = (params._dataDir as string) || undefined;

  if (action === "baseline") {
    const baseline = await buildBaseline(dataDir);
    return { ok: true, action: "baseline", ...baseline };
  }

  if (action === "compare") {
    const contentId = params.content_id as string;
    if (!contentId) return { ok: false, error: "content_id is required for compare" };
    const comparison = await compareToBaseline(contentId, dataDir);
    return { ok: true, action: "compare", ...comparison };
  }

  if (action === "track_performance") {
    const contentId = params.content_id as string;
    const metrics = params.metrics as Record<string, number>;
    if (!contentId) return { ok: false, error: "content_id is required for track_performance" };
    if (!metrics) return { ok: false, error: "metrics is required for track_performance" };
    const result = await trackPerformance(contentId, metrics, dataDir);
    return { ok: true, action: "track_performance", ...result };
  }

  if (action === "learning_report") {
    const report = await generateLearningReport(dataDir);
    return { ok: true, action: "learning_report", ...report };
  }

  // Default: overview
  const topics = await listTopics(dataDir);
  const contents = await listContents(dataDir);

  const byStatus: Record<string, number> = {};
  for (const c of contents) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  }

  return {
    ok: true,
    action: "overview",
    version: "0.1.0",
    topics: topics.length,
    contents: contents.length,
    contentsByStatus: byStatus,
    latestTopic: topics[0]?.title || null,
    latestContent: contents[0]?.title || null,
  };
}
