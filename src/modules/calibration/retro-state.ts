/**
 * 复盘后的状态更新（cheat-retro Phase 7）：
 * 样本 +1（只算完整复盘）、方向性偏差（中枢 ±25% 外）、系统性偏差提示（连续 3 次同向 / 单次 ≥10 倍）、
 * 每 10 条新样本提示一次清算。
 */
import { CLEANUP_EVERY_SAMPLES, DIRECTIONAL_STREAK, DIRECTIONAL_TOLERANCE, EXTREME_DEVIATION_RATIO } from "./constants.js";
import type { CalibrationState } from "./store.js";

export function directionOf(ratio: number): "high" | "low" | null {
  if (ratio < 1 - DIRECTIONAL_TOLERANCE) return "high"; // 实绩低于中枢 → 高估
  if (ratio > 1 + DIRECTIONAL_TOLERANCE) return "low";
  return null;
}

export function bumpSuggestion(errors: CalibrationState["consecutive_directional_errors"], ratio: number): string | null {
  if (ratio >= EXTREME_DEVIATION_RATIO || ratio <= 1 / EXTREME_DEVIATION_RATIO) {
    return `本次实绩与中枢差 ${ratio >= 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)} 倍（≥${EXTREME_DEVIATION_RATIO} 倍），可以提议升级评分表（judgment-driven：一次性强信号）`;
  }
  const tail = errors.slice(-DIRECTIONAL_STREAK);
  if (tail.length === DIRECTIONAL_STREAK && tail.every((e) => e.dir === tail[0].dir)) {
    return `连续 ${DIRECTIONAL_STREAK} 次${tail[0].dir === "high" ? "高估" : "低估"}，可以提议升级评分表（default-aligned）`;
  }
  return null;
}

export function retroStateUpdate(state: CalibrationState, predictionId: string, ratio: number, counted: boolean, now: Date) {
  const prompts: string[] = [];
  const next: CalibrationState = { ...state, last_retro_at: now.toISOString(), pending_retros: state.pending_retros.filter((p) => p !== predictionId) };
  if (!counted) {
    prompts.push("这次复盘不计入校准样本（early_retro / reconstructed / integrity warning）");
    return { state: next, prompts };
  }
  next.calibration_samples = state.calibration_samples + 1;
  const dir = directionOf(ratio);
  next.consecutive_directional_errors = dir ? [...state.consecutive_directional_errors, { dir, ratio, prediction_id: predictionId }] : [];
  const bump = bumpSuggestion(next.consecutive_directional_errors, ratio);
  if (bump) prompts.push(bump);
  if (next.calibration_samples - state.samples_at_last_cleanup >= CLEANUP_EVERY_SAMPLES) {
    prompts.push(`距上次清算已有 ${next.calibration_samples - state.samples_at_last_cleanup} 条新校准样本：该清算观察区了（calib_observe）`);
  }
  return { state: next, prompts };
}
