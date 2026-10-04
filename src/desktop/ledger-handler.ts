/**
 * calibration:ledger —— 数据页「预测账本」的只读通道（预测账本规格 §一）。
 * 读失败显式回 ok:false：「读不出来」不能被谎报成「一条预测都没有」。
 */
import { readLedger } from "../modules/calibration/ledger.js";

export async function ledgerHandler(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return { ok: true, data: await readLedger((payload._dataDir as string) || undefined) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
