/**
 * 复盘（cheat-retro，规格 §三）：T+3 主复盘只追加一次；D+7 追加读数；笔误只能追加「修正」。
 * 数据从回流取（剔除待复核指标），缺了如实说、可手填，不编。
 * 写前缓存预测主体指纹、写后复核；对不上 → 追加 Integrity warning，该样本不进校准池。
 */
import crypto from "node:crypto";
import { getContent } from "../../storage/local-store.js";
import { getOutcomesForContent } from "../flywheel/outcome-store.js";
import { normalizePlatform, type OutcomeMetrics } from "../flywheel/outcome-schema.js";
import { metricsNearAge } from "../flywheel/metrics-window.js";
import { reviewedRow } from "../insights/metric-review.js";
import { decodeArg } from "../meetings/meeting-args.js";
import { EARLY_RETRO_WEIGHT, FOLLOWUP_READING_DAY, RETRO_WINDOW_DAYS } from "./constants.js";
import { bucketOf } from "./derive.js";
import { activePredictions, readPredictions, type PredictionRecord } from "./pool.js";
import { requireText } from "./predict-input.js";
import { retroStateUpdate } from "./retro-state.js";
import { normText, readObservations } from "./obs-store.js";
import { reproject } from "./observations.js";
import { appendLog, assertLogsIntact, ensureCalibration, fingerprint, serializeCalibration, writeState } from "./store.js";

type Obj = Record<string, unknown>;
export interface Actual { views: number; likes?: number; comments?: number; shares?: number; source: string; age_days: number | null; metric_date?: string }

async function findPrediction(args: Obj, dataDir?: string): Promise<PredictionRecord> {
  const { predictions } = await readPredictions(dataDir);
  const id = typeof args.prediction_id === "string" ? args.prediction_id : "";
  const cid = typeof args.content_id === "string" ? args.content_id : "";
  const p = id ? predictions.find((x) => x.id === id) : activePredictions(predictions).filter((x) => x.content_id === cid).pop();
  if (!p) throw new Error(`找不到预测：${id || cid || "空"}（给 prediction_id 或 content_id）`);
  return p;
}

/** 回流里取近龄读数（±1 天）；没有就用手填（标 manual），都没有 → null */
export async function readActual(p: PredictionRecord, publishedAt: string | null, day: number, manual: unknown, dataDir?: string): Promise<Actual | null> {
  const rows = (await getOutcomesForContent(p.content_id, dataDir))
    .filter((r) => normalizePlatform(r.platform) === normalizePlatform(p.platform)).map(reviewedRow).filter((r) => r !== null);
  const at = metricsNearAge(rows, publishedAt, day);
  if (at && typeof at.metrics.views === "number") return pick(at.metrics, "回流", at.ageDays, at.metricDate);
  const m = decodeArg(manual) as Record<string, unknown> | undefined;
  const views = m && typeof m === "object" ? strictCount(m.views) : null;
  if (views === null) return null;
  const extra = Object.fromEntries(["likes", "comments", "shares"].map((k) => [k, strictCount(m![k]) ?? undefined]));
  return pick({ ...extra, views } as OutcomeMetrics, "手填", null);
}

/** 手填计数只收有限非负数或纯数字串；null / 空串 / 布尔 / 其它一律当没填（不当 0） */
export function strictCount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}
function pick(m: OutcomeMetrics, source: string, age: number | null, date?: string): Actual {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return { views: m.views as number, likes: n(m.likes), comments: n(m.comments), shares: n(m.shares), source, age_days: age, ...(date ? { metric_date: date } : {}) };
}

function verdicts(raw: unknown): Obj[] {
  const d = decodeArg(raw ?? []);
  if (!Array.isArray(d)) throw new Error("verified_factors 必须是数组");
  return d.map((x, i) => {
    const o = decodeArg(x) as Obj;
    if (!o || typeof o !== "object" || !["验证", "推翻", "无法判断"].includes(String(o.verdict))) throw new Error(`verified_factors[${i}] 要 {factor, verdict:验证|推翻|无法判断, note}`);
    return { factor: String(o.factor ?? ""), verdict: o.verdict, note: String(o.note ?? "") };
  });
}
function textList(raw: unknown, field: string): string[] {
  const d = decodeArg(raw ?? []);
  if (!Array.isArray(d) || d.some((x) => typeof x !== "string")) throw new Error(`${field} 必须是字符串数组`);
  return (d as string[]).map((x) => x.trim()).filter(Boolean);
}

export async function retro(args: Obj, dataDir?: string, now = new Date()): Promise<Obj> {
  const p = await findPrediction(args, dataDir);
  if (args.correction !== undefined) return appendSimple({ type: "correction", prediction_id: p.id, text: requireText(args.correction, "correction"), at: now.toISOString() }, dataDir);
  const { retros } = await readPredictions(dataDir);
  const main = retros.find((r) => r.prediction_id === p.id);
  const content = await getContent(p.content_id, dataDir);
  const publishedAt = content?.publishedAt ?? null;
  if (!publishedAt) return { ok: false, code: "not_published", error: "这篇还没有发布时间，没法按 T+3 复盘" };
  const age = (now.getTime() - Date.parse(publishedAt)) / 86_400_000;
  if (args.reading === "d7") return d7Reading(p, main, publishedAt, args, dataDir, now);
  if (main) return { ok: false, code: "retro_exists", error: "这条已经复盘过：复盘只追加一次；后续读数用 reading:\"d7\"，笔误用 correction" };
  const early = age < RETRO_WINDOW_DAYS;
  if (early && args.force_early !== true) return { ok: false, code: "too_early", error: `还差 ${(RETRO_WINDOW_DAYS - age).toFixed(1)} 天到 T+3；创始人坚持现在复盘就带 force_early:true（标 early_retro，升级时降权）` };
  const actual = await readActual(p, publishedAt, RETRO_WINDOW_DAYS, args.manual_metrics, dataDir);
  if (!actual) return noData();
  return writeRetro(p, actual, early, args, dataDir, now);
}

function noData(): Obj {
  return { ok: false, code: "no_data", error: "回流里没有这条 T+3（±1 天）的读数，也没有手填数据：不编",
    next_action: "提示创始人去开数据回流，或让他把 T+3 的播放/点赞/评论/转发手填进 manual_metrics 再复盘" };
}

async function d7Reading(p: PredictionRecord, main: unknown, publishedAt: string, args: Obj, dataDir: string | undefined, now: Date): Promise<Obj> {
  if (!main) return { ok: false, code: "no_main_retro", error: "先做 T+3 主复盘，再追加 D+7 读数" };
  const actual = await readActual(p, publishedAt, FOLLOWUP_READING_DAY, args.manual_metrics, dataDir);
  if (!actual) return { ...noData(), error: "回流里没有这条 D+7（±1 天）的读数，也没有手填数据：不编" };
  return appendSimple({ type: "reading", prediction_id: p.id, day: FOLLOWUP_READING_DAY, actual, at: now.toISOString() }, dataDir);
}

async function appendSimple(rec: Obj & { type: string }, dataDir?: string): Promise<Obj> {
  await serializeCalibration(dataDir, () => appendLog("predictions", rec, dataDir));
  return { ok: true, appended: rec.type };
}

async function writeRetro(p: PredictionRecord, actual: Actual, early: boolean, args: Obj, dataDir: string | undefined, now: Date): Promise<Obj> {
  const landed = bucketOf(actual.views, p.input_snapshot.buckets.buckets).name;
  const ratio = p.body.center > 0 ? actual.views / p.body.center : Infinity;
  const observations = textList(args.observations, "observations");
  const rec = {
    type: "retro", prediction_id: p.id, early_retro: early, actual, landed_bucket: landed, center_deviation: Math.round((ratio - 1) * 1000) / 10,
    verified_factors: verdicts(args.verified_factors), counterfactual_hit: landed,
    hypothesis_conclusion: requireText(args.hypothesis_conclusion, "hypothesis_conclusion"), observations, at: now.toISOString(),
  };
  return serializeCalibration(dataDir, async () => {
    // 唯一性在排队内再查一次：并发两次复盘不能都落盘、都 +1
    if ((await readPredictions(dataDir)).retros.some((r) => r.prediction_id === p.id)) return { ok: false, code: "retro_exists", error: "这条刚被另一次复盘落过盘" };
    await assertLogsIntact(["predictions", "rubric-memo"], dataDir); // 全有或全无：第一次写之前把要碰的日志都核一遍
    const { fp: ownFp, ...rest } = p;
    const cached = fingerprint(p.body) === p.body_fp && fingerprint(rest) === ownFp ? p.body_fp : null;
    await appendLog("predictions", rec, dataDir);
    const after = (await readPredictions(dataDir)).predictions.find((x) => x.id === p.id);
    const intact = cached !== null && after !== undefined && fingerprint(after.body) === cached && after.body_fp === cached;
    if (!intact) await appendLog("predictions", { type: "integrity_warning", prediction_id: p.id, at: now.toISOString(), detail: "复盘前后预测主体指纹不一致：该样本降为参考，不进校准池" }, dataDir);
    const { tombstones } = await readObservations(dataDir);
    const blocked = observations.filter((t) => tombstones.some((x) => normText(x.text) === normText(t)));
    for (const text of observations.filter((t) => !blocked.includes(t))) {
      await appendLog("rubric-memo", { type: "observation", id: `obs-${crypto.randomUUID().slice(0, 8)}`, stage: "observation", text, sample_ids: [p.id], source: "retro", at: now.toISOString() }, dataDir);
    }
    if (observations.length > blocked.length) await reproject(dataDir);
    const { state } = await ensureCalibration(dataDir);
    const counted = (!early || EARLY_RETRO_WEIGHT > 0) && !p.reconstructed && intact;
    const upd = retroStateUpdate(state, p.id, ratio, counted, now);
    await writeState(upd.state, dataDir);
    return { ok: true, landed_bucket: landed, predicted_bucket: p.body.bucket, center_deviation_pct: rec.center_deviation, actual,
      counted_as_calibration_sample: counted, integrity_warning: !intact, early_retro: early, prompts: upd.prompts,
      ...(blocked.length ? { tombstoned_observations: blocked } : {}) };
  });
}
