/**
 * calib_predict：预测记录 7 组件落盘（prediction-anatomy.md）。
 * 1 头 / 2 输入快照 / 3 预测主体（不可改，带 body_fp）/ 4 推理因素 / 5 锚点对比 / 6 反事实 / 7 关键校准假设。
 */
import crypto from "node:crypto";
import { ALL_DIMS, composite, type DimScores } from "./rubric.js";
import { applyDecisions, disagreementTable, readCounterfactuals, readFactors, readPredictionBody, requireText } from "./predict-input.js";
import { bucketsFor, confidenceFor, formMismatch, latestBlindRun, type BlindRunRecord } from "./predict.js";
import { calibrationPool, readPredictions, type PoolSample } from "./pool.js";
import { appendLog, ensureCalibration, fingerprint, serializeCalibration, writeState, type CalibrationState } from "./store.js";

type Obj = Record<string, unknown>;

/** 锚点：校准池里 composite ±0.5 的 2–4 个旧样本（优先同平台）；不够就写 N/A 段 */
export function pickAnchors(pool: PoolSample[], score: number, platform: string): Obj {
  const near = pool.filter((s) => Math.abs(s.prediction.composite - score) <= 0.5)
    .sort((a, b) => Number(b.prediction.platform === platform) - Number(a.prediction.platform === platform) || Math.abs(a.prediction.composite - score) - Math.abs(b.prediction.composite - score))
    .slice(0, 4);
  if (near.length < 2) return { na: true, reason: `校准池里 composite ±0.5 的样本只有 ${near.length} 个（冷启动期正常），锚点对比 N/A` };
  return { na: false, items: near.map((s) => ({ prediction_id: s.prediction.id, title: s.prediction.title, composite: s.prediction.composite, actual_views: s.actual, landed_bucket: s.retro.landed_bucket })) };
}

async function loadRun(args: Obj, dataDir?: string): Promise<BlindRunRecord> {
  const id = typeof args.blind_run_id === "string" ? args.blind_run_id : "";
  const run = id ? await latestBlindRun(id, dataDir) : null;
  if (!run) throw new Error(`blind_run_id「${id || "空"}」不存在：先 calib_blind`);
  if (run.status === "failed") throw new Error("这次盲评通道失败了：重试 calib_blind，或经创始人同意用 skip_blind:true");
  const { predictions } = await readPredictions(dataDir);
  if (predictions.some((p) => p.blind_run_id === run.id)) throw new Error("这次盲评已经落过预测：预测主体不可改，要重做用 redo_of 另开");
  return run;
}

function predictionId(run: BlindRunRecord, existing: string[]): string {
  if (!run.redo_of) return `pred-${run.content_id}-${run.created_at.slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 6)}`;
  let id = `${run.redo_of}_redo`;
  for (let i = 2; existing.includes(id); i++) id = `${run.redo_of}_redo${i}`;
  return id;
}

export async function commitPrediction(args: Obj, dataDir?: string): Promise<Obj> {
  const run = await loadRun(args, dataDir);
  const { state, rubric } = await ensureCalibration(dataDir);
  const blind: DimScores | null = run.blind ? Object.fromEntries(ALL_DIMS.map((d) => [d, run.blind![d].score])) : null;
  const decided = applyDecisions(disagreementTable(blind, run.self_scores), args.decisions);
  const scheme = await bucketsFor(run.platform, dataDir);
  const body = readPredictionBody(args.prediction, scheme.buckets, state.calibration_samples);
  const score = composite(decided.final, rubric.formula) as number;
  const record = {
    type: "prediction", id: "", content_id: run.content_id, platform: run.platform, title: run.title,
    reconstructed: run.status === "reconstructed", ...(run.redo_of ? { redo_of: run.redo_of } : {}),
    rubric_version: rubric.version, predicted_at: new Date().toISOString(), blind_run_id: run.id,
    header: {
      script_fp: run.script_fp, calibration_samples: state.calibration_samples, confidence: confidenceFor(state.calibration_samples),
      basis: args.basis === "post_shoot_rejudge" ? "拍后改稿重判" : "发布前", scored_by: "host",
      blind_scored_by: run.status === "ok" ? run.model : run.status, blind_score_disagreement: decided.rows,
      user_override: decided.override, data_state: run.status === "reconstructed" ? "Reconstructed retrospective — NOT a blind prediction" : "blind",
      published_before_prediction: run.published_before_prediction, rubric_form_mismatch: formMismatch(run.platform),
    },
    input_snapshot: { buckets: scheme, word_count: run.script_text.length, published_before_prediction: run.published_before_prediction, formula: rubric.formula_text },
    body, body_fp: fingerprint(body),
    factors: readFactors(args.factors),
    anchors: pickAnchors(await calibrationPool(dataDir), score, run.platform),
    counterfactuals: readCounterfactuals(args.counterfactuals, scheme.buckets),
    hypothesis: requireText(args.hypothesis, "hypothesis"),
    scores: { final: decided.final, blind, self: run.self_scores }, composite: score,
    trial_scores: { MS: decided.final.MS, TS: decided.final.TS },
  };
  return serializeCalibration(dataDir, async () => {
    const { predictions } = await readPredictions(dataDir);
    if (predictions.some((p) => p.blind_run_id === run.id)) throw new Error("这次盲评已经落过预测");
    record.id = predictionId(run, predictions.map((p) => p.id));
    await appendLog("predictions", record, dataDir);
    const fresh = (await ensureCalibration(dataDir)).state;
    await writeState(afterCommit(fresh, record.id, run), dataDir);
    return { ok: true, prediction_id: record.id, composite: score, confidence: record.header.confidence, bucket: body.bucket,
      reconstructed: record.reconstructed, anchors: record.anchors, trial_scores: record.trial_scores,
      next_action: record.reconstructed ? "Reconstructed 记录不进校准池" : `发布满 3 天后 calib_retro{prediction_id:"${record.id}"}` };
  });
}

function afterCommit(state: CalibrationState, id: string, run: BlindRunRecord): CalibrationState {
  const selfScored = run.status === "skipped";
  return {
    ...state, in_progress: null,
    pending_retros: run.status === "reconstructed" ? state.pending_retros : [...state.pending_retros.filter((p) => p !== run.redo_of), id],
    last_prediction_self_scored: run.status === "reconstructed" ? state.last_prediction_self_scored : selfScored,
    last_self_scored_at: run.status === "reconstructed" ? state.last_self_scored_at : selfScored ? new Date().toISOString() : null,
  };
}
