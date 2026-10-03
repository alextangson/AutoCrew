/**
 * 盲预测（cheat-predict + cheat-score-blind，规格 §二）。两步：
 *   calib_blind：盲度检查 → 封存主通道自评（先交，后看盲评）→ 盲评通道 B → 返回分歧表；
 *   calib_predict：带创始人对分歧维的裁定 + 预测主体（bucket/分布/中枢/理由、推理因素、反事实、关键假设）落盘。
 * 落盘只追加；同一稿已有生效预测时只能 redo_of 另开 _redo 记录。
 */
import crypto from "node:crypto";
import { getContent } from "../../storage/local-store.js";
import { VIDEO_PLATFORMS } from "../../storage/stage-guard.js";
import { listOutcomes } from "../flywheel/outcome-store.js";
import { normalizePlatform } from "../flywheel/outcome-schema.js";
import type { runLoop } from "../../engine/loop.js";
import { runBlindChannel, type BlindScores } from "./blind.js";
import { RETRO_WINDOW_DAYS } from "./constants.js";
import { confidenceFor, deriveBaseline, deriveBuckets } from "./derive.js";
import { activePredictions, calibrationPool, readPredictions } from "./pool.js";
import { disagreementTable, readDimScores } from "./predict-input.js";
import { ALL_DIMS, composite, rubricFormMismatch, type DimScores } from "./rubric.js";
import { appendLog, ensureCalibration, fingerprint, readLog, serializeCalibration, writeState, type ChainRecord } from "./store.js";

type Obj = Record<string, unknown>;
export type Deps = { runLoopImpl?: typeof runLoop; now?: Date };

export interface BlindRunRecord extends ChainRecord {
  type: "blind_run"; id: string; content_id: string; platform: string; title: string;
  script_text: string; script_fp: string; rubric_version: string;
  self_scores: DimScores; blind: BlindScores | null;
  status: "ok" | "failed" | "skipped" | "reconstructed"; model: string | null; endpoint?: string; error?: string; used_fallback?: string;
  published_before_prediction: boolean; redo_of?: string; created_at: string;
}

export const scriptTextOf = (c: { title: string; body: string }) => `标题：${c.title}\n\n${c.body}`;
export const ageDays = (publishedAt: string | null | undefined, now: Date) =>
  publishedAt ? (now.getTime() - Date.parse(publishedAt)) / 86_400_000 : null;

/** 盲度检查（BLIND_CHECK=strict）。返回 null = 可盲预测；否则拒绝原因 */
export function blindCheck(age: number | null, seenData: unknown): { code: string; error: string } | null {
  if (seenData === true) return { code: "not_blind", error: "对话里已经出现过这条的数据：不能再做盲预测，只能记 Reconstructed retrospective（reconstructed:true），不进校准池" };
  if (age === null) return null;
  if (age >= RETRO_WINDOW_DAYS) return { code: "not_blind", error: `已发布 ${age.toFixed(1)} 天（≥${RETRO_WINDOW_DAYS} 天）：拒绝写预测，改记 Reconstructed retrospective（reconstructed:true），不进校准池` };
  if (seenData !== false) return { code: "seen_data_unknown", error: "已发布但不到 3 天：先问创始人「看过这条的任何数据吗（播放/点赞/评论）」，没看过才填 seen_data:false" };
  return null;
}

export async function guardActive(contentId: string, redoOf: unknown, dataDir?: string): Promise<string | null> {
  const { predictions } = await readPredictions(dataDir);
  const active = activePredictions(predictions).filter((p) => p.content_id === contentId);
  if (typeof redoOf === "string" && redoOf) {
    return active.some((p) => p.id === redoOf) ? null : `redo_of「${redoOf}」不是这篇当前生效的预测`;
  }
  return active.length ? `这篇已有生效预测 ${active[0].id}：预测主体不可改，要重做只能 redo_of 另开 _redo 记录（原记录保留）` : null;
}

export async function blindStep(args: Obj, dataDir?: string, deps: Deps = {}): Promise<Obj> {
  const now = deps.now ?? new Date();
  const contentId = typeof args.content_id === "string" ? args.content_id.trim() : "";
  const content = contentId ? await getContent(contentId, dataDir) : null;
  if (!content) return { ok: false, code: "not_found", error: `稿件不存在：${contentId || "空"}` };
  const reconstructed = args.reconstructed === true;
  const age = ageDays(content.publishedAt, now);
  const blocked = reconstructed ? null : blindCheck(age, args.seen_data);
  if (blocked) return { ok: false, ...blocked };
  const self = readDimScores(args.self_scores, "self_scores");
  const activeErr = await guardActive(content.id, args.redo_of, dataDir);
  if (activeErr) return { ok: false, code: "prediction_exists", error: activeErr };
  const { rubric } = await ensureCalibration(dataDir);
  const scriptText = scriptTextOf(content);
  const base = {
    type: "blind_run", id: `blind-${crypto.randomUUID()}`, content_id: content.id, platform: content.platform ?? "",
    title: content.title, script_text: scriptText, script_fp: fingerprint(scriptText), rubric_version: rubric.version,
    self_scores: self, published_before_prediction: age !== null, created_at: now.toISOString(),
    ...(typeof args.redo_of === "string" && args.redo_of ? { redo_of: args.redo_of } : {}),
  };
  const outcome = reconstructed ? { status: "reconstructed" as const }
    : args.skip_blind === true ? { status: "skipped" as const }
    : await runBlindChannel(scriptText, rubric, dataDir, { runLoopImpl: deps.runLoopImpl })
      .then((r) => ({ status: "ok" as const, ...r }), (err: unknown) => ({ status: "failed" as const, error: err instanceof Error ? err.message : String(err) }));
  const rec = { ...base, status: outcome.status, blind: "scores" in outcome ? outcome.scores : null,
    model: "model" in outcome ? outcome.model : null, ...("error" in outcome ? { error: outcome.error } : {}),
    ...("endpoint" in outcome ? { endpoint: outcome.endpoint } : {}),
    ...("usedFallback" in outcome && outcome.usedFallback ? { used_fallback: outcome.usedFallback } : {}) };
  await serializeCalibration(dataDir, async () => {
    await appendLog("blind-runs", rec, dataDir);
    const { state } = await ensureCalibration(dataDir);
    if (outcome.status !== "failed") await writeState({ ...state, in_progress: { blind_run_id: rec.id, content_id: content.id, started_at: rec.created_at, rubric_version: rubric.version } }, dataDir);
  });
  return blindStepResult(rec as unknown as BlindRunRecord, rubric.formula);
}

function blindStepResult(rec: BlindRunRecord, formula: Parameters<typeof composite>[1]): Obj {
  if (rec.status === "failed") {
    return { ok: false, code: "blind_failed", blind_run_id: rec.id, error: `盲评通道失败：${rec.error}`,
      next_action: "已记为 failed。重试 calib_blind；创始人同意跳过盲评时用 skip_blind:true（会记 self-scored，晨报持续提醒）" };
  }
  const rows = disagreementTable(rec.blind ? Object.fromEntries(ALL_DIMS.map((d) => [d, rec.blind![d].score])) : null, rec.self_scores);
  return {
    ok: true, blind_run_id: rec.id, status: rec.status, scored_by: rec.model,
    blind: rec.blind, disagreement: rows, needs_decision: rows.filter((r) => (r.delta ?? 0) >= 2).map((r) => r.dim),
    composite: { self: composite(rec.self_scores, formula), blind: rec.blind ? composite(Object.fromEntries(ALL_DIMS.map((d) => [d, rec.blind![d].score])), formula) : null },
    next_action: "把 needs_decision 里的每一维摆给创始人选「信盲评 / 信主通道 / 自己给分」，再 calib_predict 交预测主体",
  };
}

/** 本平台 bucket 方案：校准池中位数 / D+3 同龄基线 / 平台默认 */
export async function bucketsFor(platform: string, dataDir?: string, now = new Date()) {
  const [outcomes, pool] = await Promise.all([listOutcomes(dataDir), calibrationPool(dataDir)]);
  const poolViews = pool.filter((s) => normalizePlatform(s.prediction.platform) === normalizePlatform(platform)).map((s) => s.actual);
  return deriveBuckets(deriveBaseline(platform, outcomes, poolViews, now));
}

export async function latestBlindRun(id: string, dataDir?: string): Promise<BlindRunRecord | null> {
  const { records, integrity } = await readLog<BlindRunRecord>("blind-runs", dataDir);
  const run = records.find((r) => r.id === id) ?? null;
  if (!run) return null;
  const { fp, ...body } = run;
  if (!integrity.ok || fingerprint(body) !== fp) {
    throw new Error(`盲评记录完整性校验没过（${integrity.problems[0] ?? "这条记录内容与指纹不符"}）：不能拿被改过的输入落预测或补打分`);
  }
  return run;
}

export const formMismatch = (platform: string) => rubricFormMismatch(platform, VIDEO_PLATFORMS);
export { confidenceFor };
