/**
 * 预测账本的只读模型（预测账本规格 §一）：汇总条 + 每条预测一行（新的在上）。
 * 只读：不建目录、不写任何东西；预测、复盘、解读、读数全来自 predictions.jsonl 的追加记录。
 * 状态：待复盘（显示到期日）/ 等数据 / 已对账 / 已解读 / 事后补记 / 完整性警告。
 */
import { getContent } from "../../storage/local-store.js";
import { normalizePlatform } from "../flywheel/outcome-schema.js";
import { DISAGREEMENT_THRESHOLD, FOLLOWUP_READING_DAY, RETRO_WINDOW_DAYS } from "./constants.js";
import { confidenceFor, type ConfidenceLabel } from "./derive.js";
import { ledgerAlerts } from "./ledger-alerts.js";
import { activePredictions, calibrationPool, isInterpreted, readPredictions, type PredictionRecord } from "./pool.js";
import { readActual } from "./retro.js";
import { readReconcileStatus, type ReconcileStatus } from "./reconcile-status.js";
import { readStateIfExists, type ChainRecord } from "./store.js";

const DAY = 86_400_000;
export type LedgerStatus = "pending" | "awaiting_data" | "reconciled" | "interpreted" | "reconstructed" | "integrity_warning";
export interface LedgerActual { views: number; landed_bucket: string; deviation_pct: number; hit: boolean; metric_date: string | null; source: string; by: "auto" | "manual" }
export interface LedgerRow {
  id: string; content_id: string; title: string; platform: string; predicted_at: string;
  bucket: string; distribution: Record<string, number>; center: number; confidence: string | null; disagreements: number;
  status: LedgerStatus; due_date: string | null; actual: LedgerActual | null; d7: { views: number; metric_date: string | null } | null;
  detail: { reason: string; factors: unknown; counterfactuals: unknown; hypothesis: unknown; records: Array<Record<string, unknown>> };
}
export interface LedgerSummary {
  rubric_version: string | null; samples: number; confidence: ConfidenceLabel;
  hit_rate: Array<{ platform: string; n: number; hits: number }>; alerts: string[];
  counts: { pending: number; due: number; awaiting_data: number; awaiting_interpretation: number };
  reconcile: ReconcileStatus | null; integrity_problems: string[];
}
export interface Ledger { summary: LedgerSummary; rows: LedgerRow[] }

type Read = Awaited<ReturnType<typeof readPredictions>>;
const strip = (r: ChainRecord) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "fp" && k !== "prev"));

export async function readLedger(dataDir?: string, now = new Date()): Promise<Ledger> {
  const state = await readStateIfExists(dataDir);
  const read = await readPredictions(dataDir);
  const rows: LedgerRow[] = [];
  for (const p of activePredictions(read.predictions)) rows.push(await rowOf(p, read, dataDir, now));
  rows.sort((a, b) => (a.predicted_at < b.predicted_at ? 1 : -1));
  const pool = await calibrationPool(dataDir);
  const samples = state?.calibration_samples ?? 0;
  const summary: LedgerSummary = {
    rubric_version: state?.rubric_version ?? null, samples, confidence: confidenceFor(samples),
    hit_rate: hitRate(pool.map((s) => ({ platform: s.prediction.platform, hit: s.retro.landed_bucket === s.prediction.body.bucket }))),
    alerts: state ? ledgerAlerts(state, pool) : [],
    counts: countsOf(rows, now),
    reconcile: await readReconcileStatus(dataDir), integrity_problems: read.integrity.problems,
  };
  return { summary, rows };
}

export function hitRate(items: Array<{ platform: string; hit: boolean }>): LedgerSummary["hit_rate"] {
  const map = new Map<string, { platform: string; n: number; hits: number }>();
  for (const it of items) {
    const k = normalizePlatform(it.platform);
    const e = map.get(k) ?? { platform: k, n: 0, hits: 0 };
    e.n += 1; e.hits += it.hit ? 1 : 0;
    map.set(k, e);
  }
  return [...map.values()];
}

export function countsOf(rows: LedgerRow[], now: Date): LedgerSummary["counts"] {
  const pending = rows.filter((r) => r.status === "pending");
  return {
    pending: pending.length,
    due: pending.filter((r) => r.due_date !== null && Date.parse(r.due_date) <= now.getTime()).length,
    awaiting_data: rows.filter((r) => r.status === "awaiting_data").length,
    awaiting_interpretation: rows.filter((r) => r.status === "reconciled").length,
  };
}

async function rowOf(p: PredictionRecord, read: Read, dataDir: string | undefined, now: Date): Promise<LedgerRow> {
  const publishedAt = (await getContent(p.content_id, dataDir))?.publishedAt ?? null;
  const due = publishedAt ? new Date(Date.parse(publishedAt) + RETRO_WINDOW_DAYS * DAY).toISOString() : null;
  const retro = read.retros.find((r) => r.prediction_id === p.id) ?? null;
  const d7 = read.readings.find((r) => r.prediction_id === p.id && r.day === FOLLOWUP_READING_DAY) ?? null;
  const header = (p.header ?? {}) as { confidence?: { label?: string }; blind_score_disagreement?: Array<{ delta: number | null }> };
  return {
    id: p.id, content_id: p.content_id, title: p.title, platform: p.platform, predicted_at: p.predicted_at,
    bucket: p.body.bucket, distribution: p.body.distribution, center: p.body.center, confidence: header.confidence?.label ?? null,
    disagreements: (header.blind_score_disagreement ?? []).filter((r) => (r.delta ?? 0) >= DISAGREEMENT_THRESHOLD).length,
    status: await statusOf(p, read, publishedAt, dataDir, now), due_date: due,
    actual: retro ? { views: retro.actual.views, landed_bucket: retro.landed_bucket, deviation_pct: retro.center_deviation, hit: retro.landed_bucket === p.body.bucket,
      metric_date: (retro.actual as { metric_date?: string }).metric_date ?? null, source: retro.actual.source, by: retro.numeric_by ?? "manual" } : null,
    d7: d7 ? { views: d7.actual.views, metric_date: d7.actual.metric_date ?? null } : null,
    detail: { reason: p.body.reason, factors: p.factors, counterfactuals: p.counterfactuals, hypothesis: p.hypothesis,
      records: read.records.filter((r) => r.type !== "prediction" && r.prediction_id === p.id).map(strip) },
  };
}

async function statusOf(p: PredictionRecord, read: Read, publishedAt: string | null, dataDir: string | undefined, now: Date): Promise<LedgerStatus> {
  if (p.reconstructed) return "reconstructed";
  if (read.warned.has(p.id) || !read.selfOk(p)) return "integrity_warning";
  const retro = read.retros.find((r) => r.prediction_id === p.id);
  if (retro) return isInterpreted(retro, read.interpretations) ? "interpreted" : "reconciled";
  if (!publishedAt || now.getTime() - Date.parse(publishedAt) < RETRO_WINDOW_DAYS * DAY) return "pending";
  // 到期：有可用回流 → 下一轮自动对账会写（仍算待复盘）；没有 → 等数据
  return (await readActual(p, publishedAt, RETRO_WINDOW_DAYS, undefined, dataDir, RETRO_WINDOW_DAYS)) ? "pending" : "awaiting_data";
}
