/**
 * 评分表升级（cheat-bump，规格 §四）。5 步，不许跳：
 *   1 完整方程 → 2 校准池全量重算（新增维度补打分走盲评通道）→ 3 排序门（80%、逐对不倒序）
 *   → 4 跨模型审计 C（本地与审计都过才放行，冲突=REJECT）→ 5 清算（bump-cleanup.ts）。
 * 禁止提议：有进行中的预测；上次升级后没有新校准样本。软约束（池 <5、新样本 <3）可打破，但要写明理由。
 * 阈值不收参数——想放宽本身是另一件元层级的事。
 */
import { decodeArg } from "../meetings/meeting-args.js";
import type { runLoop } from "../../engine/loop.js";
import { runAudit } from "./audit.js";
import { runBlindChannel } from "./blind.js";
import { applyBump, ids, recordRejection } from "./bump-cleanup.js";
import { SOFT_MIN_NEW_SAMPLES, SOFT_MIN_POOL } from "./constants.js";
import { calibrationPool, readPredictions, type PoolSample } from "./pool.js";
import { latestBlindRun, type BlindRunRecord } from "./predict.js";
import { rankGate, type GateSample, type RankGateResult } from "./rank-gate.js";
import { ALL_DIMS, composite, formulaText, type DimKey, type DimScores, type RubricFormula } from "./rubric.js";
import { ensureCalibration, type CalibrationState } from "./store.js";

type Obj = Record<string, unknown>;
export type BumpDeps = { blindLoop?: typeof runLoop; auditLoop?: typeof runLoop };

export function readFormula(raw: unknown): RubricFormula {
  const o = decodeArg(raw) as Obj;
  if (!o || typeof o !== "object") throw new Error("formula 要 {weights:{维度:权重}, divisor, multiplier} 完整方程");
  const w = decodeArg(o.weights) as Obj;
  if (!w || typeof w !== "object" || !Object.keys(w).length) throw new Error("formula.weights 要写出所有进分维度的权重");
  const weights: Partial<Record<DimKey, number>> = {};
  for (const [k, v] of Object.entries(w)) {
    if (!(ALL_DIMS as readonly string[]).includes(k)) throw new Error(`维度 ${k} 不在评分表里（只能用 ${ALL_DIMS.join("/")}）`);
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`formula.weights.${k} 要正数`);
    weights[k as DimKey] = n;
  }
  const divisor = Number(o.divisor), multiplier = Number(o.multiplier);
  if (!(divisor > 0) || !(multiplier > 0)) throw new Error("formula.divisor 与 formula.multiplier 都要写明（正数），不能只说「把 ER 提到 2.0」");
  return { weights, divisor, multiplier };
}

/** 硬门 + 软门；返回拒绝原因或 null */
export function proposalGate(state: CalibrationState, poolSize: number, args: Obj): string | null {
  if (args.threshold !== undefined) return "THRESHOLD 写死 80%，不收参数：放宽阈值本身是另一次元层级升级";
  if (state.in_progress) return `有进行中的预测（${state.in_progress.content_id}）：先落完那条预测再提升级`;
  const fresh = state.calibration_samples - state.calibration_samples_at_last_bump;
  if (fresh <= 0) return "上次升级后没有新校准样本：禁止提议";
  if (poolSize < 2) return `校准池只有 ${poolSize} 个样本，排不了序`;
  const soft = poolSize < SOFT_MIN_POOL || fresh < SOFT_MIN_NEW_SAMPLES;
  const reason = typeof args.soft_violation_reason === "string" ? args.soft_violation_reason.trim() : "";
  if (soft && !reason) return `软约束未满足（校准池 ${poolSize} <${SOFT_MIN_POOL} 或距上次升级新样本 ${fresh} <${SOFT_MIN_NEW_SAMPLES}）：要提议就写明 soft_violation_reason，并标 judgment-driven`;
  if (soft && args.kind !== "judgment-driven") return "打破软约束的提议只能是 judgment-driven";
  if (args.kind !== "default-aligned" && args.kind !== "judgment-driven") return "kind 只能是 default-aligned 或 judgment-driven";
  return null;
}

export type DimSource = { source: "blind" | "self" | "backfill"; endpoint?: string };
export type Provenance = Partial<Record<DimKey, DimSource>>;
type Effective = { scores: DimScores; provenance: Provenance };
const reusable = (p?: DimSource) => p?.source === "blind" || p?.source === "backfill";

/** 每个样本按版本生效的维度分与逐维出处：最近一次升级追加的 rescored（没有出处的老记录一律当自评） */
export async function effectiveScores(dataDir?: string): Promise<Map<string, Effective>> {
  const { records, selfOk } = await readPredictions(dataDir);
  const out = new Map<string, Effective>();
  for (const r of records) {
    if (r.type === "rescored" && r.scores && selfOk(r)) out.set(String(r.prediction_id), { scores: r.scores as DimScores, provenance: (r.provenance as Provenance) ?? {} });
  }
  return out;
}

/** 预测时的出处：创始人裁定「信盲评」且盲评成功的维度 = blind（带实际线路），其余 = self */
function predictionProvenance(s: PoolSample, run: BlindRunRecord | null): Provenance {
  const rows = ((s.prediction as unknown as { header?: { blind_score_disagreement?: Array<{ dim: DimKey; decided_as?: string }> } }).header?.blind_score_disagreement) ?? [];
  const out: Provenance = {};
  for (const d of ALL_DIMS) {
    const row = rows.find((x) => x.dim === d);
    out[d] = run?.status === "ok" && row?.decided_as === "blind" ? { source: "blind", ...(run.endpoint ? { endpoint: run.endpoint } : {}) } : { source: "self" };
  }
  return out;
}

type SampleScores = Effective & { backfilled: boolean };

/** 新增维度（旧公式没用到）的分：出处是盲评/补打的生效分 > 预测时盲评分 > 对存档稿子补跑一次盲评通道；自评分绝不复用 */
async function newDimScores(s: PoolSample, newDims: DimKey[], eff: Effective | undefined, dataDir: string | undefined, deps: BumpDeps): Promise<SampleScores> {
  const run = await latestBlindRun(s.prediction.blind_run_id, dataDir);
  const scores: DimScores = { ...(eff?.scores ?? s.prediction.scores.final) };
  const provenance: Provenance = { ...predictionProvenance(s, run), ...(eff?.provenance ?? {}) };
  const missing: DimKey[] = [];
  for (const d of newDims) {
    if (eff && reusable(eff.provenance[d]) && typeof eff.scores[d] === "number") continue;
    if (run?.status === "ok" && typeof s.prediction.scores.blind?.[d] === "number") {
      scores[d] = s.prediction.scores.blind[d];
      provenance[d] = { source: "blind", ...(run.endpoint ? { endpoint: run.endpoint } : {}) };
    } else missing.push(d);
  }
  if (!missing.length) return { scores, provenance, backfilled: false };
  if (!run) throw new Error(`样本 ${s.prediction.id} 的稿子存档不见了，没法补打分`);
  const { rubric } = await ensureCalibration(dataDir);
  const b = await runBlindChannel(run.script_text, rubric, dataDir, { runLoopImpl: deps.blindLoop });
  for (const d of missing) { scores[d] = b.scores[d].score; provenance[d] = { source: "backfill", endpoint: b.endpoint }; }
  return { scores, provenance, backfilled: true };
}

export type GateRow = GateSample & { scores: DimScores; provenance: Provenance; backfilled: boolean; actualDetail: unknown };

export async function buildGateSamples(pool: PoolSample[], oldF: RubricFormula, newF: RubricFormula, dataDir: string | undefined, deps: BumpDeps) {
  const newDims = (Object.keys(newF.weights) as DimKey[]).filter((d) => !(d in oldF.weights));
  const eff = await effectiveScores(dataDir);
  const samples: GateRow[] = [];
  const endpoints = new Set<string>();
  for (const s of pool) {
    const e = eff.get(s.prediction.id);
    const r = await newDimScores(s, newDims, e, dataDir, deps);
    // 审计独立性：凡是进了新公式的维度，它的分来自哪条盲评线路都要算上（含以前补打、这次复用的）
    for (const d of Object.keys(newF.weights) as DimKey[]) { const ep = r.provenance[d]?.endpoint; if (ep) endpoints.add(ep); }
    const base = e?.scores ?? s.prediction.scores.final;
    samples.push({ id: s.prediction.id, label: s.prediction.title, oldScore: composite(base, oldF) ?? s.prediction.composite,
      newScore: composite(r.scores, newF) as number, actual: s.actual, weight: s.weight, scores: r.scores, provenance: r.provenance, backfilled: r.backfilled, actualDetail: s.retro.actual });
  }
  return { samples, newDims, blindEndpoints: [...endpoints] };
}

/** 交给审计的是门里实际用的生效分（含补打分），不是预测时的原始分 */
export function auditPayload(oldText: string, newText: string, samples: GateRow[], gate: RankGateResult): string {
  const rows = samples.map((s) => ({ id: s.id, title: s.label, scores: s.scores, weight: s.weight ?? 1, composite_old: s.oldScore, composite_new: s.newScore, actual: s.actualDetail }));
  return `旧公式：${oldText}\n新公式：${newText}\n\n校准池（维度分、实绩）：\n${JSON.stringify(rows)}\n\n排序对照：\n${JSON.stringify({ table: gate.table, spearman: gate.spearman, consistency: gate.consistency, regressions: gate.regressions, soft_regressions: gate.soft_regressions })}`;
}

export async function proposeBump(args: Obj, dataDir?: string, deps: BumpDeps = {}): Promise<Obj> {
  const { state, rubric } = await ensureCalibration(dataDir);
  const pool = await calibrationPool(dataDir);
  const blocked = proposalGate(state, pool.length, args);
  if (blocked) return { ok: false, code: "bump_not_allowed", error: blocked };
  const formula = readFormula(args.formula);
  ids(args.absorbs_observations, "absorbs_observations"); // 坏参数在调模型前就打回
  ids(args.refutes_observations, "refutes_observations");
  const newText = formulaText(formula);
  const { samples, newDims, blindEndpoints } = await buildGateSamples(pool, rubric.formula, formula, dataDir, deps);
  const gate = rankGate(samples);
  const base = { from: rubric.version, old_formula: rubric.formula_text, new_formula: newText, kind: args.kind, rationale: args.rationale, gate };
  if (!gate.pass) return recordRejection({ ...base, step: 3, reason: gate.reasons.join("；") }, dataDir);
  const audit = await runAudit(auditPayload(rubric.formula_text, newText, samples, gate), dataDir, { runLoopImpl: deps.auditLoop, blindEndpoints });
  if (audit.verdict !== "PASS") return recordRejection({ ...base, step: 4, reason: audit.verdict === "REJECT" ? "本地 PASS + 审计 REJECT，视为 REJECT" : audit.reason, audit }, dataDir);
  const snapshot = { version: rubric.version, samples: state.calibration_samples, atLastBump: state.calibration_samples_at_last_bump, poolIds: pool.map((p) => p.prediction.id).sort() };
  return applyBump({ ...base, formula, newDims, samples, audit, args, snapshot }, dataDir);
}
