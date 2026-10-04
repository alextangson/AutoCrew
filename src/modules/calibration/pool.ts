/**
 * 校准池：有完整复盘、实绩可用的预测。early_retro 留在池里但带降权（EARLY_RETRO_WEIGHT）。以下一律不进池（规格 §二/§三）：
 * Reconstructed retrospective、带 Integrity warning、自身指纹对不上的记录。
 */
import { EARLY_RETRO_WEIGHT } from "./constants.js";
import { fingerprint, readLog, type ChainRecord } from "./store.js";
import type { DimScores } from "./rubric.js";
import type { BucketScheme } from "./derive.js";

export interface PredictionRecord extends ChainRecord {
  type: "prediction";
  id: string;
  content_id: string;
  platform: string;
  title: string;
  reconstructed: boolean;
  redo_of?: string;
  rubric_version: string;
  predicted_at: string;
  body: { bucket: string; distribution: Record<string, number>; center: number; reason: string };
  body_fp: string;
  scores: { final: DimScores; blind: DimScores | null; self: DimScores };
  composite: number;
  input_snapshot: { buckets: BucketScheme; word_count: number; published_before_prediction: boolean };
  blind_run_id: string;
}

export interface RetroRecord extends ChainRecord {
  type: "retro";
  prediction_id: string;
  early_retro: boolean;
  actual: { views: number; likes?: number; comments?: number; shares?: number; source: string; age_days: number | null };
  landed_bucket: string;
  center_deviation: number;
  /** 数字部分是谁写的：auto = 回流后自动对账（不含解读）；缺省 = 手动 calib_retro（旧记录数字+解读同一行） */
  numeric_by?: "auto" | "manual";
  hypothesis_conclusion?: string;
  at: string;
}

/** 自动对账之后在对话里补的解读（验证/推翻、结论、新观察）：只追加，不计样本 */
export interface InterpretationRecord extends ChainRecord {
  type: "interpretation"; prediction_id: string; hypothesis_conclusion: string; verified_factors: unknown[]; observations: string[]; at: string;
}
export interface ReadingRecord extends ChainRecord { type: "reading"; prediction_id: string; day: number; actual: RetroRecord["actual"] & { metric_date?: string }; at: string; by?: string }

/** 已解读 = 主复盘自带结论（手动复盘），或之后追加过解读记录 */
export function isInterpreted(retro: RetroRecord, interpretations: InterpretationRecord[]): boolean {
  return typeof retro.hypothesis_conclusion === "string" || interpretations.some((i) => i.prediction_id === retro.prediction_id);
}

export interface PoolSample { prediction: PredictionRecord; retro: RetroRecord; actual: number; weight: number }

const selfOk = (r: ChainRecord) => { const { fp, ...body } = r; return fingerprint(body) === fp; };

export async function readPredictions(dataDir?: string) {
  const { records, integrity } = await readLog<ChainRecord>("predictions", dataDir);
  const predictions = records.filter((r): r is PredictionRecord => r.type === "prediction");
  const retros = records.filter((r): r is RetroRecord => r.type === "retro");
  const interpretations = records.filter((r): r is InterpretationRecord => r.type === "interpretation");
  const readings = records.filter((r): r is ReadingRecord => r.type === "reading");
  const warned = new Set(records.filter((r) => r.type === "integrity_warning").map((r) => String(r.prediction_id)));
  return { records, predictions, retros, interpretations, readings, warned, integrity, selfOk };
}

/** 一条预测当前是否仍生效：没被 _redo 取代 */
export function activePredictions(predictions: PredictionRecord[]): PredictionRecord[] {
  const replaced = new Set(predictions.map((p) => p.redo_of).filter(Boolean));
  return predictions.filter((p) => !replaced.has(p.id));
}

export async function calibrationPool(dataDir?: string): Promise<PoolSample[]> {
  const { predictions, retros, warned } = await readPredictions(dataDir);
  const out: PoolSample[] = [];
  for (const p of predictions) {
    if (p.reconstructed || warned.has(p.id) || !selfOk(p)) continue;
    const retro = retros.find((r) => r.prediction_id === p.id && selfOk(r));
    if (!retro || !(retro.actual.views >= 0)) continue;
    const weight = retro.early_retro ? EARLY_RETRO_WEIGHT : 1;
    if (weight <= 0) continue;
    out.push({ prediction: p, retro, actual: retro.actual.views, weight });
  }
  return out;
}
