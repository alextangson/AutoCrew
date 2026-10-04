/**
 * 数字对账自动化（预测账本规格 §二）：回流 tick 跑完后，给到期预测追加「数字对账」——
 * T+3 主读数（计一个校准样本）与 D+7 追加读数。只追加、不碰预测本体、永不提前、不做解读。
 * 跳过：事后补记（reconstructed）、完整性警告、已有主复盘的（手动复盘过的不重复写）。
 * 没有可用回流（含剔除待复核指标后没有播放）→ 不写，留在「等数据」。
 * 写入前核资料库写入锁；丢锁 / 日志完整性没过 / 其它出错 → 一行不写，原因记进对账状态（账本 + 晨报可见）。
 */
import { getContent } from "../../storage/local-store.js";
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { FOLLOWUP_READING_DAY, RETRO_WINDOW_DAYS } from "./constants.js";
import { activePredictions, readPredictions, type PredictionRecord } from "./pool.js";
import { commitRetro, numericPart, readActual, type WriteGuard } from "./retro.js";
import { saveReconcileStatus, type ReconcileStatus } from "./reconcile-status.js";
import { appendLog, readStateIfExists, serializeCalibration } from "./store.js";

const DAY = 86_400_000;
export interface ReconcileDeps { now?: Date; guard?: WriteGuard }

function lockCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith("library_writer_lost") ? "library_writer_lost" : "library_unavailable";
}

/** 跑一轮；不抛错——任何失败都写进返回的状态并保存 */
export async function reconcileDue(dataDir?: string, deps: ReconcileDeps = {}): Promise<ReconcileStatus> {
  const now = deps.now ?? new Date();
  const guard = deps.guard ?? (() => assertDataDirWritable(dataDir));
  const status: ReconcileStatus = { at: now.toISOString(), ok: true, written: [], waiting: [], waiting_d7: [], prompts: [] };
  if (!(await readStateIfExists(dataDir).catch(() => null))) return status; // 还没做过任何预测：不建目录
  try { guard(); } catch (err) {
    const fail = { ...status, ok: false, code: lockCode(err), error: `没有资料库写入权，本轮自动对账一行没写：${(err as Error).message}` };
    await saveReconcileStatus(fail, dataDir, false);
    return fail;
  }
  try {
    await runRound(status, dataDir, now, guard);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    Object.assign(status, { ok: false, code: /完整性/.test(msg) ? "integrity" : msg.startsWith("library_") ? lockCode(err) : "error", error: msg });
  }
  await saveReconcileStatus(status, dataDir, status.code === undefined || status.code === "integrity" || status.code === "error").catch((err: unknown) => {
    Object.assign(status, { ok: false, code: "error", error: `对账状态没写住：${(err as Error).message}` });
  });
  return status;
}

async function runRound(status: ReconcileStatus, dataDir: string | undefined, now: Date, guard: WriteGuard): Promise<void> {
  const { predictions, warned, integrity, selfOk } = await readPredictions(dataDir);
  if (!integrity.ok) throw new Error(`predictions.jsonl 完整性校验没过（${integrity.problems[0]}）：自动对账一行没写`);
  for (const p of activePredictions(predictions)) {
    if (p.reconstructed || warned.has(p.id) || !selfOk(p)) continue;
    const content = await getContent(p.content_id, dataDir);
    const publishedAt = content?.publishedAt ?? null;
    if (!publishedAt) continue;
    const age = (now.getTime() - Date.parse(publishedAt)) / DAY;
    if (age < RETRO_WINDOW_DAYS) continue; // 永不提前
    await mainReading(p, publishedAt, status, dataDir, now, guard);
    if (age >= FOLLOWUP_READING_DAY) await followupReading(p, publishedAt, status, dataDir, now, guard);
  }
}

async function mainReading(p: PredictionRecord, publishedAt: string, status: ReconcileStatus, dataDir: string | undefined, now: Date, guard: WriteGuard): Promise<void> {
  if ((await readPredictions(dataDir)).retros.some((r) => r.prediction_id === p.id)) return;
  const actual = await readActual(p, publishedAt, RETRO_WINDOW_DAYS, undefined, dataDir, RETRO_WINDOW_DAYS);
  if (!actual) { status.waiting.push(p.id); return; }
  const { rec, ratio } = numericPart(p, actual, false, now, "auto");
  const r = await commitRetro(p, rec, ratio, [], dataDir, now, guard);
  if (r.ok !== true) return; // 排队内发现刚被手动复盘落过：不重复写
  status.written.push({ prediction_id: p.id, kind: "t3" });
  status.prompts.push(...((r.prompts as string[]) ?? []).map((x) => `${p.title}：${x}`));
}

async function followupReading(p: PredictionRecord, publishedAt: string, status: ReconcileStatus, dataDir: string | undefined, now: Date, guard: WriteGuard): Promise<void> {
  const cur = await readPredictions(dataDir);
  if (!cur.retros.some((r) => r.prediction_id === p.id)) return; // 主读数还没落：D+7 等它
  if (cur.readings.some((r) => r.prediction_id === p.id && r.day === FOLLOWUP_READING_DAY)) return;
  const actual = await readActual(p, publishedAt, FOLLOWUP_READING_DAY, undefined, dataDir, FOLLOWUP_READING_DAY);
  if (!actual) { status.waiting_d7.push(p.id); return; }
  const wrote = await serializeCalibration(dataDir, async () => {
    const fresh = await readPredictions(dataDir);
    if (!fresh.retros.some((r) => r.prediction_id === p.id)) return false;
    if (fresh.readings.some((r) => r.prediction_id === p.id && r.day === FOLLOWUP_READING_DAY)) return false;
    guard();
    await appendLog("predictions", { type: "reading", prediction_id: p.id, day: FOLLOWUP_READING_DAY, actual, by: "auto", at: now.toISOString() }, dataDir);
    return true;
  });
  if (wrote) status.written.push({ prediction_id: p.id, kind: "d7" });
}
