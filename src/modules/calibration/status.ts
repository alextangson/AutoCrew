/** 校准状态总览：评分表、样本数、提醒（晨报也读这里的提醒） */
import { readLedger } from "./ledger.js";
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
export async function calibrationReminders(dataDir?: string, now = new Date()): Promise<string[]> {
  const state = await readStateIfExists(dataDir);
  const out: string[] = [];
  if (!state) return out;
  if (state.last_prediction_self_scored) {
    const days = state.last_self_scored_at ? Math.floor((Date.now() - Date.parse(state.last_self_scored_at)) / 86_400_000) : 0;
    out.push(`上次预测没走盲评通道（自评），已 ${days} 天；下次预测请走盲评`);
  }
  const { summary } = await readLedger(dataDir, now);
  const c = summary.counts;
  if (c.due) out.push(`${c.due} 条预测已到 T+3、有回流数据，下一轮自动对账会写`);
  if (c.awaiting_data) out.push(`${c.awaiting_data} 条预测到期但没有可用回流数据（等数据，不编不当 0）`);
  if (c.awaiting_interpretation) out.push(`${c.awaiting_interpretation} 条预测已数字对账、待解读（对话里 calib_retro 补验证/推翻与新观察）`);
  if (summary.reconcile && !summary.reconcile.ok) out.push(`自动对账没写成：${summary.reconcile.error}`);
  return [...out, ...summary.alerts];
}
