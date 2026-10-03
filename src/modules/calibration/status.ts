/** 校准状态总览：评分表、样本数、提醒（晨报也读这里的提醒） */
import { ensureCalibration, readLog, readStateIfExists } from "./store.js";

export async function calibrationStatus(dataDir?: string): Promise<Record<string, unknown>> {
  const { state, rubric } = await ensureCalibration(dataDir);
  const [preds, memo, runs] = await Promise.all([readLog("predictions", dataDir), readLog("rubric-memo", dataDir), readLog("blind-runs", dataDir)]);
  const integrity = [preds, memo, runs].flatMap((l, i) => l.integrity.problems.map((p) => `${["predictions", "rubric-memo", "blind-runs"][i]}：${p}`));
  return {
    rubric: { version: rubric.version, formula: rubric.formula_text, trial_dimensions: rubric.trial_dimensions },
    state,
    integrity_problems: integrity,
    reminders: await calibrationReminders(dataDir),
  };
}

/** 晨报与 calib_status 共用的提醒行 */
export async function calibrationReminders(dataDir?: string): Promise<string[]> {
  const state = await readStateIfExists(dataDir);
  const out: string[] = [];
  if (!state) return out;
  if (state.last_prediction_self_scored) {
    const days = state.last_self_scored_at ? Math.floor((Date.now() - Date.parse(state.last_self_scored_at)) / 86_400_000) : 0;
    out.push(`上次预测没走盲评通道（自评），已 ${days} 天；下次预测请走盲评`);
  }
  if (state.pending_retros.length) out.push(`${state.pending_retros.length} 条预测等复盘（发布满 3 天后 calib_retro）`);
  return out;
}
