/**
 * 行级入库漏斗 —— TypedRow[] → outcomes.jsonl 的唯一批量通道（spec §4.1，codex #9/#10）。
 *
 * 三条来源（自动抓取 / CSV 导入 / 扩展桥）最终都汇到这里：
 * 一次读全量建幂等索引 → 逐行校验（不合格行 rejected，合格行照常入库）→ 批内同键 last-wins
 * → 单次 append。幂等键不含 platformItemId，所以三通道重复导入永远同键去重，不重复计数。
 *
 * 批内语义（写死在测试里）：
 * - 同 outcomeKey 后行覆盖前行；`replaced` 计数含批内覆盖；
 * - 暴涨检测只对照**批前存量**（与逐条 recordOutcome 的首行行为一致，批内新行不抬高基数）。
 */
import {
  resolveItemBinding,
  commitResolvedBindings,
  listOutcomes,
  appendOutcomes,
  serializeOutcomeWrite,
  collectPeerViews,
  spikeReviewReason,
} from "./outcome-store.js";
import type { PendingBinding } from "./platform-items.js";
import {
  validateOutcome,
  outcomeKey,
  normalizePlatform,
  type OutcomeMetrics,
  type OutcomeSource,
  type PerformanceOutcome,
} from "./outcome-schema.js";
import { localDateStamp } from "../analytics/quality-baseline.js";
import type { TypedRow } from "../../adapters/browser/pull-types.js";

export interface ImportReport {
  total: number;
  imported: number;
  replaced: number;
  matched: number;
  historical: number;
  needsReview: PerformanceOutcome[];
  rejected: Array<{ row: number; title: string; error: string }>;
}

export interface RowImportOptions {
  source: OutcomeSource;
  /** 行不带数据日期时的批次默认值（默认今天，本地时区） */
  metricDate?: string;
  dataDir?: string;
  /** rejected 行号基数：CSV 带表头传 2（第一数据行 = 文件第 2 行），默认 1 */
  rowNumberBase?: number;
}

interface RowContext {
  platform: string;
  source: OutcomeSource;
  defaultMetricDate: string;
  dataDir?: string;
  /** 批前存量的同平台 views 样本，整批共用 */
  peerViews: number[];
}

type PreparedRow = { outcome: PerformanceOutcome; pending: PendingBinding | null } | { error: string };

/** undefined/非数值一律剔除：JSON 落盘不留空键，校验也只看真实数值 */
function compactMetrics(metrics: Partial<OutcomeMetrics>): OutcomeMetrics {
  const out: OutcomeMetrics = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number") out[key as keyof OutcomeMetrics] = value;
  }
  return out;
}

async function prepareRow(row: TypedRow, ctx: RowContext): Promise<PreparedRow> {
  const title = (row.title ?? "").trim();
  if (!title) return { error: "标题为空" };
  const metrics = compactMetrics(row.metrics ?? {});
  if (Object.keys(metrics).length === 0) return { error: "没有任何指标值" };

  // 归属与登记走 outcome-store 的公用裁决（绑定表 > matchDraft，spec §5.1）
  const binding = await resolveItemBinding({
    platform: ctx.platform,
    platformTitle: title,
    publishedAt: row.publishedAt,
    platformItemId: row.platformItemId,
    dataDir: ctx.dataDir,
  });
  const input = {
    contentId: binding.contentId,
    platform: ctx.platform,
    platformTitle: title,
    publishedAt: row.publishedAt,
    metricDate: row.metricDate || ctx.defaultMetricDate,
    ...(row.platformItemId ? { platformItemId: row.platformItemId } : {}),
    metrics,
    source: ctx.source,
  };
  const validation = validateOutcome(input);
  if (!validation.ok) return { error: validation.reasons.join("；") };

  const reviewReasons = [...validation.reasons, ...binding.reviewReasons];
  const spike = spikeReviewReason(ctx.peerViews, metrics.views);
  if (spike) reviewReasons.push(spike);
  return {
    outcome: {
      ...input,
      recordedAt: new Date().toISOString(),
      needsReview: reviewReasons.length > 0,
      reviewReasons,
    },
    pending: binding.pending,
  };
}

function emptyReport(total: number): ImportReport {
  return { total, imported: 0, replaced: 0, matched: 0, historical: 0, needsReview: [], rejected: [] };
}

export async function importPerformanceRows(
  platform: string,
  rows: TypedRow[],
  opts: RowImportOptions,
): Promise<ImportReport> {
  const rowBase = opts.rowNumberBase ?? 1;
  return serializeOutcomeWrite(opts.dataDir, async () => {
    const existing = await listOutcomes(opts.dataDir);
    const existingKeys = new Set(existing.map((o) => outcomeKey(o)));
    const ctx: RowContext = {
      platform: normalizePlatform(platform),
      source: opts.source,
      defaultMetricDate: opts.metricDate || localDateStamp(),
      dataDir: opts.dataDir,
      peerViews: collectPeerViews(existing, platform),
    };

    const report = emptyReport(rows.length);
    const staged = new Map<string, PerformanceOutcome>(); // 同键后行覆盖前行
    const pending: PendingBinding[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const prepared = await prepareRow(rows[i], ctx);
      if ("error" in prepared) {
        report.rejected.push({ row: rowBase + i, title: rows[i].title ?? "", error: prepared.error });
        continue;
      }
      if (prepared.pending) pending.push(prepared.pending);
      const key = outcomeKey(prepared.outcome);
      report.imported += 1;
      if (existingKeys.has(key) || staged.has(key)) report.replaced += 1;
      if (prepared.outcome.contentId) report.matched += 1;
      else report.historical += 1;
      staged.set(key, prepared.outcome);
    }

    const finals = [...staged.values()];
    report.needsReview = finals.filter((o) => o.needsReview); // 只报真正落盘的那条
    await appendOutcomes(finals, opts.dataDir);
    // 先 outcomes 后绑定：绑定是索引，写序反了会出现「指着不存在的行」的绑定
    await commitResolvedBindings(pending, opts.dataDir);
    return report;
  });
}
