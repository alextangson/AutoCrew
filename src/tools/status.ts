import { Type } from "@sinclair/typebox";
import { calibrationReminders } from "../modules/calibration/status.js";
import { listTopics, listContents, getDataDir } from "../storage/local-store.js";
import { isVideoPlatform } from "../storage/stage-guard.js";
import { cutOpts, deskInbox, dispatchedInbox } from "./desk.js";
import { scanUnregisteredCuts, type CutScanOptions } from "../modules/video/unregistered-cut.js";
import { buildBaseline, compareToBaseline, trackPerformance } from "../modules/analytics/quality-baseline.js";
import { generateLearningReport } from "../modules/learnings/visible-learning.js";
import { engineFallbackStats } from "../runtime/run-log.js";
import { explainAll } from "../modules/production/read.js";
import { readReconcileReport } from "../modules/production/reconcile.js";
import { isOntologyEnabled } from "../storage/production-store.js";
import { briefLine, programRoot } from "../modules/update/check.js";
import { getMachineDir } from "../storage/storage-roots.js";

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
  if (params.brief === true) {
    const result = await briefStatus(dataDir, cutOpts(params));
    // 有新版本时晨报带一句（self-update §2-5）；读的是本机目录里最近一次检查的结果，不现查网络
    const update = briefLine(programRoot(), getMachineDir(params._machineDir as string | undefined));
    const calibration = await calibrationReminders(dataDir); // 判断要对账：上次预测没走盲评要持续提醒
    return { ...result, ...(update ? { update } : {}), ...(calibration.length ? { calibration } : {}) };
  }
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
/**
 * 本体启用后的晨报桶（spec §8 同步改口）：待写 / 待认稿 / 等 A-roll / 剪辑中 / 等你审 / 待发布，候选待确认不为 0 才出现。
 * 全部来自 explain()：「等你审」= 剪辑中且还差「成片待你审 / 封面待你选」或有待核发布回执。
 */
async function ontologyBrief(dir: string) {
  const [writer, contents] = await Promise.all([deskInbox("writer", dir), listContents(dir)]);
  const exp = await explainAll(contents, dir);
  const report = await readReconcileReport(dir);
  const e = (c: { id: string }) => exp.get(c.id);
  const REVIEW = new Set(["成片待你审", "封面待你选"]);
  const pendingClaim = (c: { id: string }) => (e(c)?.badges ?? []).some((b) => b.endsWith("是吗？"));
  const waitingYou = (c: { id: string }) => e(c)?.column === "剪辑中" && e(c)!.missing.some((m) => REVIEW.has(m));
  const counts = {
    to_write: writer.length + contents.filter((c) => c.status === "drafting").length,
    awaiting_approval: contents.filter((c) => c.status === "draft_ready" && e(c)?.column === "写稿中").length,
    awaiting_aroll: contents.filter((c) => e(c)?.column === "待录制").length,
    editing: contents.filter((c) => e(c)?.column === "剪辑中" && !waitingYou(c)).length,
    your_review: contents.filter(waitingYou).length,
    publish_ready: contents.filter((c) => e(c)?.column === "待发布").length,
    // 候选待确认：文件候选（是不是这条）与待核发布回执（AI 说发了，是吗？）
    candidates: contents.filter((c) => (e(c)?.candidates.length ?? 0) > 0 || pendingClaim(c)).length,
  };
  // 对账失败与登记提醒（登记没完成、投影没写完…）都进晨报（Codex 审 seg4 P2）
  const warnings = [...(report?.errors ?? []).map((x) => `对账失败：${x.title}（${x.id}）${x.error}`), ...(report?.warnings ?? [])];
  const brief = `${counts.to_write} 待写 / ${counts.awaiting_approval} 待认稿 / ${counts.awaiting_aroll} 等 A-roll / ${counts.editing} 剪辑中 / ${counts.your_review} 等你审 / ${counts.publish_ready} 待发布`
    + (counts.candidates ? ` / ${counts.candidates} 候选待确认` : "") + (warnings.length ? `（${warnings.length} 条要看的对账问题）` : "");
  return { ok: true, action: "overview", brief, counts, ...(warnings.length ? { warnings } : {}) };
}

async function briefStatus(dataDir?: string, opts: CutScanOptions = {}) {
  const dir = getDataDir(dataDir);
  if (await isOntologyEnabled(dir).catch(() => false)) return ontologyBrief(dir);
  const [writer, dispatched, contents] = await Promise.all([deskInbox("writer", dir), dispatchedInbox(dir), listContents(dir)]);
  const video = contents.filter((c) => isVideoPlatform(c.platform));
  const scan = await scanUnregisteredCuts(contents, dir, opts);
  // 列归属用 explain()（本体 §2.6，与看板、我的内容同一个）；未启用本体时按旧状态给
  const exp = await explainAll(contents, dir);
  const col = (c: { id: string }) => exp.get(c.id)?.column ?? null;
  const report = await readReconcileReport(dir);
  const counts = {
    // 写手桌 = 已选立意没稿的选题 + 退回修订；再加包已发出、稿没回来的 drafting
    to_write: writer.length + contents.filter((c) => c.status === "drafting").length,
    // AI 写完、等创始人认稿（剪完未登记的视频稿扣出去单算）
    awaiting_approval: contents.filter((c) => c.status === "draft_ready" && col(c) === "写稿中" && !scan.hits.has(c.id)).length,
    // 创始人认过的视频稿、还没有任何制作事实（待录制）
    awaiting_aroll: video.filter((c) => col(c) === "待录制" && !scan.hits.has(c.id)).length,
    // 同样没交接，但外面已经导出成片 / 做了封面
    cut_unregistered: scan.hits.size,
    // 在剪辑台、这一版成片还没审过（P6-a 之前「已派工」就是它）
    dispatched: dispatched.filter((item) => isVideoPlatform(item.platform)).length,
    // 视频稿按 explain 的列；图文照旧只数 publish_ready（图文的「已过审」在旧列里也归待发布，但还没排版）
    publish_ready: contents.filter((c) => (isVideoPlatform(c.platform) ? col(c) === "待发布" : c.status === "publish_ready")).length,
  };
  // 对账失败要看得见（§4 逐条隔离）：晨报 warnings 带上
  const warnings = [...scan.warnings, ...(report?.errors ?? []).map((e) => `对账失败：${e.title}（${e.id}）${e.error}`)];
  const warnSuffix = scan.warnings.length ? "（读不了导出目录）" : report?.errors.length ? `（${report.errors.length} 条对账失败）` : "";
  const brief = `${counts.to_write} 待写 / ${counts.awaiting_approval} 待认稿 / ${counts.awaiting_aroll} 等 A-roll / ${counts.cut_unregistered} 剪完未登记 / ${counts.dispatched} 已派工待登记 / ${counts.publish_ready} 待发布${warnSuffix}`;
  return { ok: true, action: "overview", brief, counts, ...(warnings.length ? { warnings } : {}) };
}
