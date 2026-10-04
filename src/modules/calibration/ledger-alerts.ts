/**
 * 账本汇总条与晨报的提醒（规格 §二.5）：照现有规则，从状态与校准池现算，不另存一份会过期的提醒。
 *   连续 3 次同向偏差 / 上次升级以来有单次 ≥10 倍偏差 / 距上次清算满 10 条新样本。
 */
import { CLEANUP_EVERY_SAMPLES } from "./constants.js";
import type { PoolSample } from "./pool.js";
import { bumpSuggestion } from "./retro-state.js";
import type { CalibrationState } from "./store.js";

export function ledgerAlerts(state: CalibrationState, pool: PoolSample[]): string[] {
  const out: string[] = [];
  const streak = bumpSuggestion(state.consecutive_directional_errors, 1);
  if (streak) out.push(streak);
  const since = state.last_bump_at ? Date.parse(state.last_bump_at) : 0;
  for (const s of pool) {
    const ratio = s.prediction.body.center > 0 ? s.actual / s.prediction.body.center : Infinity;
    if (Date.parse(String(s.retro.at ?? "")) <= since) continue;
    const extreme = bumpSuggestion([], ratio);
    if (extreme) out.push(`《${s.prediction.title}》${extreme}`);
  }
  const fresh = state.calibration_samples - state.samples_at_last_cleanup;
  if (fresh >= CLEANUP_EVERY_SAMPLES) out.push(`距上次清算已有 ${fresh} 条新校准样本：该清算观察区了（calib_observe）`);
  return out;
}
