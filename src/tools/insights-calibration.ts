/**
 * autocrew_insights 的「判断要对账」动作（docs/2026-10-03-prediction-calibration-spec.md）。
 * 参数统一走 calib 对象（模型传来的 JSON 串照收）；每个动作的原始错误如实返回，不静默降级。
 */
import { decodeArg } from "../modules/meetings/meeting-args.js";
import { calibrationStatus } from "../modules/calibration/status.js";

export const CALIB_ACTIONS = ["calib_status"] as const;

export const CALIB_DESCRIPTION = [
  "判断要对账（技能 video-session 第 6 步）：calib_status 看评分表版本、校准样本数、置信度、待复盘与提醒。",
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
    calibArg(raw);
    if (action === "calib_status") return { ok: true, ...(await calibrationStatus(dir)) };
    return { ok: false, error: `未知动作 ${action}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), next_action: "把原始错误告诉创始人；校准记录不会被改写或跳过。" };
  }
}
