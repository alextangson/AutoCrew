/**
 * 升级第 5 步「清算」与被拒处理（bump-validation-protocol.md Step 5）。
 * 一次做完：版本号与速查表、memo、删被吸收/被推翻的观察（留墓碑）、未解决的移到「待验证假设」、
 * 每个校准样本追加一行「Re-scored under vN」。任一步失败整体回滚；被拒的完整理由记进被拒 log。
 */
import { BLIND_LEAK_RE } from "./constants.js";
import type { AuditVerdict } from "./audit.js";
import { projectObservations, readObservations } from "./obs-store.js";
import type { GateSample, RankGateResult } from "./rank-gate.js";
import { rubricLeaks, type DimKey, type Rubric, type RubricFormula } from "./rubric.js";
import { appendLog, ensureCalibration, serializeCalibration, snapshotSizes, truncateTo, writeRubric, writeState } from "./store.js";

type Obj = Record<string, unknown>;
interface BumpBase { from: string; old_formula: string; new_formula: string; kind: unknown; rationale: unknown; gate: RankGateResult }

export async function recordRejection(rec: BumpBase & { step: number; reason: string; audit?: AuditVerdict }, dataDir?: string): Promise<Obj> {
  await serializeCalibration(dataDir, () => appendLog("rubric-memo", { type: "rejected_bump", ...rec, candidate_status: "待验证", at: new Date().toISOString() }, dataDir));
  return { ok: false, code: "bump_rejected", step: rec.step, error: `升级被拒（第 ${rec.step} 步）：${rec.reason}`, gate: rec.gate, audit: rec.audit,
    next_action: "候选公式回到「待验证」；不许放宽阈值，攒更多样本再提" };
}

export function nextVersion(v: string): string {
  const m = /^v(\d+)(?:\.(\d+))?$/.exec(v);
  return m ? `v${m[1]}.${Number(m[2] ?? 0) + 1}` : `${v}.1`;
}

const ids = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);

export async function applyBump(input: BumpBase & { formula: RubricFormula; newDims: DimKey[]; samples: Array<GateSample & { backfilled: boolean }>; audit: AuditVerdict; args: Obj }, dataDir?: string): Promise<Obj> {
  return serializeCalibration(dataDir, async () => {
    const { state, rubric } = await ensureCalibration(dataDir);
    const { live } = await readObservations(dataDir);
    const absorbed = ids(input.args.absorbs_observations), refuted = ids(input.args.refutes_observations);
    const unknown = [...absorbed, ...refuted].filter((id) => !live.some((o) => o.id === id));
    if (unknown.length) return { ok: false, code: "unknown_observation", error: `观察 ${unknown.join("、")} 不在当前观察区` };
    const version = nextVersion(rubric.version);
    const now = new Date().toISOString();
    const remaining = live.filter((o) => !absorbed.includes(o.id) && !refuted.includes(o.id));
    const moved = remaining.map((o) => (o.stage === "observation" || o.stage === "cross_video" ? { ...o, stage: "hypothesis" as const } : o));
    const next: Rubric = { ...rubric, version, formula: input.formula, formula_text: input.new_formula,
      trial_dimensions: rubric.trial_dimensions.filter((d) => !input.newDims.includes(d)),
      observations: projectObservations(moved, (t) => BLIND_LEAK_RE.test(t)),
      changelog: [...rubric.changelog, { version, date: now.slice(0, 10), formula_text: input.new_formula }] };
    const leaks = rubricLeaks(next);
    if (leaks.length) return { ok: false, code: "rubric_leak", error: `新 rubric.json 混进了数据：${leaks[0]}，回滚` };
    const sizes = await snapshotSizes(dataDir);
    try {
      await appendCleanup(input, { version, absorbed, refuted, remaining, now }, dataDir);
      await writeState({ ...state, rubric_version: version, last_bump_at: now, calibration_samples_at_last_bump: state.calibration_samples, consecutive_directional_errors: [] }, dataDir);
      await writeRubric(next, dataDir);
    } catch (err) {
      await truncateTo(sizes, dataDir);
      await writeState(state, dataDir);
      await writeRubric(rubric, dataDir);
      return { ok: false, code: "cleanup_failed", error: `清算失败已回滚：${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, version, formula: input.new_formula, gate: input.gate, audit: input.audit, rescored: input.samples.length };
  });
}

type BumpInput = Parameters<typeof applyBump>[0];
interface CleanupPlan { version: string; absorbed: string[]; refuted: string[]; remaining: Array<{ id: string; stage: string }>; now: string }

async function appendCleanup(input: BumpInput, plan: CleanupPlan, dataDir?: string): Promise<void> {
  const { version, absorbed, refuted, remaining, now } = plan;
  await appendLog("rubric-memo", { type: "bump_memo", from: input.from, to: version, kind: input.kind, rationale: input.rationale,
    old_formula: input.old_formula, new_formula: input.new_formula, trigger_observations: absorbed, refuted_observations: refuted,
    evidence: input.gate, audit: input.audit, known_limitations: input.args.known_limitations ?? null, soft_violation_reason: input.args.soft_violation_reason ?? null, at: now }, dataDir);
  for (const id of absorbed) await appendLog("rubric-memo", { type: "obs_delete", id, reason: "absorbed", version, at: now }, dataDir);
  for (const id of refuted) await appendLog("rubric-memo", { type: "obs_delete", id, reason: "refuted", version, at: now }, dataDir);
  for (const o of remaining) if (o.stage === "observation" || o.stage === "cross_video") await appendLog("rubric-memo", { type: "obs_stage", id: o.id, stage: "hypothesis", reason: `升级到 ${version} 时未解决`, at: now }, dataDir);
  for (const s of input.samples) await appendLog("predictions", { type: "rescored", prediction_id: s.id, version, from: s.oldScore, to: s.newScore, backfilled: s.backfilled, at: now }, dataDir);
}
