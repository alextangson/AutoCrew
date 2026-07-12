/**
 * autocrew_flywheel — 性能闭环工具（PRD v3 §6/§7.2c 的 dogfood 入口）。
 * actions:
 *   import_csv — 导入平台创作者中心导出的 CSV（历史回灌 + 周常回填共用）
 *   record    — 手动回填单条数据（结构化粘贴兜底）
 *   report    — 闭环状态：条数、待人工确认、baseline 洞察
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { importPerformanceCsv } from "../modules/flywheel/csv-import.js";
import { listOutcomes, listLatestOutcomes } from "../modules/flywheel/outcome-store.js";
import { buildBaseline, trackPerformance, localDateStamp } from "../modules/analytics/quality-baseline.js";
import { getDataDir } from "../storage/local-store.js";

export const flywheelSchema = Type.Object({
  action: Type.Unsafe<"import_csv" | "record" | "report">({
    type: "string",
    enum: ["import_csv", "record", "report"],
    description:
      "Flywheel action. 'import_csv' to ingest platform CSV export, 'record' for manual metrics entry, 'report' for loop status.",
  }),
  platform: Type.Optional(
    Type.String({ description: "Platform key for import_csv: douyin | wechat_video | xiaohongshu | wechat_mp." }),
  ),
  csv_path: Type.Optional(Type.String({ description: "Path to the exported CSV file (for import_csv)." })),
  csv_text: Type.Optional(Type.String({ description: "CSV content passed directly (alternative to csv_path; GUI file picker uses this)." })),
  metric_date: Type.Optional(
    Type.String({
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "YYYY-MM-DD the metrics refer to (import_csv and record). Defaults to today.",
    }),
  ),
  content_id: Type.Optional(Type.String({ description: "AutoCrew content id (for record)." })),
  metrics: Type.Optional(
    Type.Record(Type.String(), Type.Number(), {
      description: "Metrics for record action, e.g. {\"views\":800,\"completionRate\":41}.",
    }),
  ),
  platform_title: Type.Optional(
    Type.String({
      description: "平台上显示的标题，补录 CSV 未匹配行时填写，使历史条目被正确替代（record 用，默认草稿标题）。",
    }),
  ),
});

/** `~/` 展开到 homedir（runbook day-1 命令用 ~ 路径；path.resolve 不展开 ~）。导出仅为单测。 */
export function expandPath(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : path.resolve(p);
}

async function runImportCsv(params: Record<string, unknown>, dataDir: string) {
  const platform = params.platform as string | undefined;
  const csvPath = params.csv_path as string | undefined;
  const csvTextParam = params.csv_text as string | undefined;
  if (!platform || (!csvPath && !csvTextParam)) {
    return { ok: false, error: "import_csv 需要 platform + csv_path 或 csv_text(GUI 文件选择走 csv_text 直传)" };
  }
  let csvText: string;
  if (csvTextParam !== undefined) {
    csvText = csvTextParam;
  } else {
    try {
      csvText = await fs.readFile(expandPath(csvPath as string), "utf-8");
    } catch {
      return { ok: false, error: `读不到 CSV 文件：${csvPath}` };
    }
  }
  const metricDate = (params.metric_date as string) || localDateStamp();
  try {
    return { ok: true, data: await importPerformanceCsv(platform, csvText, metricDate, dataDir) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runReport(dataDir: string) {
  const outcomes = await listOutcomes(dataDir); // 快照视角（一行 = 某作品某数据日期）
  const works = await listLatestOutcomes(dataDir); // 作品视角（每作品最新快照）
  const baseline = await buildBaseline(dataDir);
  const byPlatform: Record<string, number> = {};
  for (const w of works) {
    byPlatform[w.platform] = (byPlatform[w.platform] || 0) + 1;
  }
  return {
    ok: true,
    data: {
      totalOutcomes: outcomes.length, // 快照数，周常重复导入下按周增长——可靠性核对看 works
      works: {
        total: works.length,
        matched: works.filter((w) => w.contentId !== null).length,
        historical: works.filter((w) => w.contentId === null).length,
        // 作品明细(V5.6.2 数据回流页):最新数据日期倒序取 20,GUI 明细表与 MCP 同吃
        items: [...works]
          .sort((a, b) => (a.metricDate < b.metricDate ? 1 : -1))
          .slice(0, 20)
          .map((w) => ({ title: w.platformTitle, platform: w.platform, metricDate: w.metricDate, metrics: w.metrics })),
      },
      byPlatform,
      needsReview: outcomes.filter((o) => o.needsReview),
      avgMetrics: baseline.avgMetrics,
      baselineSampleSize: baseline.sampleSize,
      traitSampleSize: baseline.traitSampleSize,
      baselineInsights: baseline.insights,
    },
  };
}

export async function executeFlywheel(params: Record<string, unknown>) {
  const action = params.action as string;
  const dataDir = getDataDir((params._dataDir as string) || undefined);

  if (action === "import_csv") {
    return runImportCsv(params, dataDir);
  }

  if (action === "record") {
    const contentId = params.content_id as string | undefined;
    const metrics = params.metrics as Record<string, unknown> | undefined;
    if (!contentId || !metrics) {
      return { ok: false, error: "record 需要 content_id 和 metrics" };
    }
    const numeric: Record<string, number> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(metrics)) {
      if (typeof v === "number") numeric[k] = v;
      else dropped.push(k);
    }
    if (dropped.length > 0) {
      return { ok: false, error: `这些指标不是数字：${dropped.join("、")}（请传数值，如 41 而不是 "41%"）` };
    }
    const result = await trackPerformance(
      contentId,
      numeric,
      dataDir,
      params.metric_date as string | undefined,
      params.platform_title as string | undefined,
    );
    return result.ok ? { ok: true, data: result } : { ok: false, error: result.error || "回填失败" };
  }

  if (action === "report") {
    return runReport(dataDir);
  }

  return { ok: false, error: `Unknown action: ${action}` };
}
