/**
 * autocrew_insights 的「判断要对账」动作（docs/2026-10-03-prediction-calibration-spec.md）。
 * 参数统一走 calib 对象（模型传来的 JSON 串照收）；每个动作的原始错误如实返回，不静默降级。
 */
import { decodeArg } from "../modules/meetings/meeting-args.js";
import { calibrationStatus } from "../modules/calibration/status.js";
import { blindStep } from "../modules/calibration/predict.js";
import { commitPrediction } from "../modules/calibration/commit.js";
import { retro } from "../modules/calibration/retro.js";
import { proposeBump } from "../modules/calibration/bump.js";
import { observe } from "../modules/calibration/observations.js";

export const CALIB_ACTIONS = ["calib_status", "calib_blind", "calib_predict", "calib_retro", "calib_bump", "calib_observe"] as const;

export const CALIB_DESCRIPTION = [
  "判断要对账（技能 video-session 第 6 步）：calib_status 看评分表版本、校准样本数、置信度、待复盘与提醒。",
  "calib_blind{content_id, self_scores:{ER,SR,HP,QL,NA,AB,SAT,MS,TS 各 0–5}, seen_data?, skip_blind?, reconstructed?, redo_of?}：盲度检查，先封存你的自评，再起盲评通道（只喂稿子+rubric），返回分歧表。",
  "calib_predict{blind_run_id, decisions?:{维度:\"blind\"|\"self\"|0–5}, prediction:{bucket, distribution:{5 档百分比合计 100}, center, reason}, factors:[{factor,direction:+|-,confidence:高|中|低,note}], counterfactuals:{每档一段}, hypothesis, basis?}：落预测（不可改）。",
  "calib_retro{prediction_id|content_id, hypothesis_conclusion, verified_factors?:[{factor,verdict:验证|推翻|无法判断,note}], observations?:[一句话], manual_metrics?:{views,likes,comments,shares}, force_early?} T+3 复盘（只追加一次，数据取回流、缺了手填不编）；reading:\"d7\" 追加 D+7 读数；correction 追加修正。",
  "calib_bump{formula:{weights,divisor,multiplier}, kind:default-aligned|judgment-driven, rationale, absorbs_observations?, refutes_observations?, known_limitations?, soft_violation_reason?}：5 步升级（重算→排序门 80%+逐对不倒序→跨模型审计→清算），不收阈值参数。",
  "calib_observe{op:list|add|promote|settle|retire|rule_conflict|cleanup_done, id?, text?, to?:cross_video|hypothesis, sample_ids?, soft_reason?, reason?:absorbed|refuted|settled, rule?, rule_id?}：观察生命周期；settle 只建待批写作规则，规则从不被数据自动改。",
].join("\n");

type Obj = Record<string, unknown>;
export function calibArg(v: unknown): Obj {
  if (v === undefined || v === null) return {};
  const d = decodeArg(v);
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`calib 必须是对象（收到 ${typeof d}）`);
  return d as Obj;
}

export async function executeCalibrationAction(action: string, raw: unknown, dir: string, _host: string): Promise<Obj> {
  try {
    const args = calibArg(raw);
    if (action === "calib_blind") return await blindStep(args, dir);
    if (action === "calib_predict") return await commitPrediction(args, dir);
    if (action === "calib_retro") return await retro(args, dir);
    if (action === "calib_bump") return await proposeBump(args, dir);
    if (action === "calib_observe") return await observe(args, dir);
    if (action === "calib_status") return { ok: true, ...(await calibrationStatus(dir)) };
    return { ok: false, error: `未知动作 ${action}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), next_action: "把原始错误告诉创始人；校准记录不会被改写或跳过。" };
  }
}
