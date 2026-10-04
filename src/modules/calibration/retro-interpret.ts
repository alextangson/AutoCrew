/**
 * 复盘的解读部分（预测账本规格 §二.4）：数字对账（自动或手动）之后，在对话里补「哪些判断被验证/推翻、结论、新观察」。
 * 只追加一条 interpretation 记录；不碰预测本体、不改数字、不计样本（样本在数字对账时已经计过，创始人裁定 2026-10-04）。
 */
import type { PredictionRecord } from "./pool.js";
import { readPredictions } from "./pool.js";
import { requireText } from "./predict-input.js";
import { textList, verdicts, writeObservations } from "./retro.js";
import { appendLog, assertLogsIntact, serializeCalibration } from "./store.js";

type Obj = Record<string, unknown>;

export async function appendInterpretation(p: PredictionRecord, args: Obj, dataDir: string | undefined, now: Date): Promise<Obj> {
  const observations = textList(args.observations, "observations");
  const rec = {
    type: "interpretation", prediction_id: p.id, hypothesis_conclusion: requireText(args.hypothesis_conclusion, "hypothesis_conclusion"),
    verified_factors: verdicts(args.verified_factors), observations, at: now.toISOString(),
  };
  return serializeCalibration(dataDir, async () => {
    const { retros, interpretations } = await readPredictions(dataDir);
    const main = retros.find((r) => r.prediction_id === p.id);
    if (!main) return { ok: false, code: "no_main_retro", error: "这条还没有数字对账，不能单独补解读" };
    if (typeof main.hypothesis_conclusion === "string" || interpretations.some((i) => i.prediction_id === p.id)) {
      return { ok: false, code: "retro_exists", error: "这条已经解读过：要改只能 correction 追加修正" };
    }
    await assertLogsIntact(["predictions", "rubric-memo"], dataDir);
    await appendLog("predictions", rec, dataDir);
    const blocked = await writeObservations(p.id, observations, dataDir, now);
    return { ok: true, appended: "interpretation", landed_bucket: main.landed_bucket, predicted_bucket: p.body.bucket,
      counted_as_calibration_sample: false, note: "数字部分已在对账时计过样本，这次只追加解读，不重复计数",
      ...(blocked.length ? { tombstoned_observations: blocked } : {}) };
  });
}
