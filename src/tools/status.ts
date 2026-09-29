import { Type } from "@sinclair/typebox";
import { listTopics, listContents, getDataDir } from "../storage/local-store.js";
import { isVideoPlatform } from "../storage/stage-guard.js";
import { cutOpts, deskInbox, dispatchedInbox } from "./desk.js";
import { scanUnregisteredCuts, type CutScanOptions } from "../modules/video/unregistered-cut.js";
import { buildBaseline, compareToBaseline, trackPerformance } from "../modules/analytics/quality-baseline.js";
import { generateLearningReport } from "../modules/learnings/visible-learning.js";
import { engineFallbackStats } from "../runtime/run-log.js";

export const statusSchema = Type.Object({
  action: Type.Optional(Type.Unsafe<"overview" | "baseline" | "compare" | "track_performance" | "learning_report">({
    type: "string",
    enum: ["overview", "baseline", "compare", "track_performance", "learning_report"],
    description:
      "Action: 'overview' (default) pipeline status, 'baseline' quality baseline from history, " +
      "'compare' compare content to baseline, 'track_performance' record metrics, 'learning_report' show learning progress.",
  })),
  verbose: Type.Optional(Type.Boolean({ description: "Show detailed counts" })),
  brief: Type.Optional(Type.Boolean({
    description: "overview only: one line 'N 待写 / N 待认稿 / N 等 A-roll / N 剪完未登记 / N 已派工待登记 / N 待发布' plus counts (SessionStart hook).",
  })),
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
    return { action: "track_performance", ...result };
  }

  if (action === "learning_report") {
    const report = await generateLearningReport(dataDir);
    return { ok: true, action: "learning_report", ...report };
  }

  // Default: overview
  if (params.brief === true) return briefStatus(dataDir, cutOpts(params));
  const [topics, contents, engine] = await Promise.all([listTopics(dataDir), listContents(dataDir), engineFallbackStats(dataDir)]);

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
    // 引擎回退可见（P6 §3.9）：24 h 内备用顶上的占比与熔断跳过次数，读 run-log 现算
    engine,
  };
}

/**
 * SessionStart hook 的一行待办（P6 §3.2）：只数数，清单在 autocrew_desk inbox。
 * 待写与已派工直接复用写手桌 / 剪辑师桌的判据，不另起一套会和桌子各说各的口径。
 * 剪完未登记（外面导出了没交接）从待认稿 / 等 A-roll 里扣出来单算，不重复计数。
 */
async function briefStatus(dataDir?: string, opts: CutScanOptions = {}) {
  const dir = getDataDir(dataDir);
  const [writer, dispatched, contents] = await Promise.all([deskInbox("writer", dir), dispatchedInbox(dir), listContents(dir)]);
  const video = contents.filter((c) => isVideoPlatform(c.platform));
  const scan = await scanUnregisteredCuts(contents, dir, opts);
  const counts = {
    // 写手桌 = 已选立意没稿的选题 + 退回修订；再加包已发出、稿没回来的 drafting
    to_write: writer.length + contents.filter((c) => c.status === "drafting").length,
    // AI 写完、等创始人认稿（剪完未登记的视频稿扣出去单算）
    awaiting_approval: contents.filter((c) => c.status === "draft_ready" && !scan.hits.has(c.id)).length,
    // 创始人认过的视频稿、还没进剪辑台：handoff 把它推到 editing
    awaiting_aroll: video.filter((c) => c.status === "approved" && !scan.hits.has(c.id)).length,
    // 同样没交接，但外面已经导出成片 / 做了封面
    cut_unregistered: scan.hits.size,
    // 在剪辑台、这一版成片还没审过（P6-a 之前「已派工」就是它）
    dispatched: dispatched.filter((item) => isVideoPlatform(item.platform)).length,
    publish_ready: contents.filter((c) => c.status === "publish_ready").length,
  };
  const warnSuffix = scan.warnings.length ? "（读不了导出目录）" : "";
  const brief = `${counts.to_write} 待写 / ${counts.awaiting_approval} 待认稿 / ${counts.awaiting_aroll} 等 A-roll / ${counts.cut_unregistered} 剪完未登记 / ${counts.dispatched} 已派工待登记 / ${counts.publish_ready} 待发布${warnSuffix}`;
  return { ok: true, action: "overview", brief, counts, ...(scan.warnings.length ? { warnings: scan.warnings } : {}) };
}
