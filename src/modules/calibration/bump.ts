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
import { applyBump, recordRejection } from "./bump-cleanup.js";
import { SOFT_MIN_NEW_SAMPLES, SOFT_MIN_POOL } from "./constants.js";
import { calibrationPool, type PoolSample } from "./pool.js";
import { latestBlindRun } from "./predict.js";
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

/** 新增维度（旧公式没用到）的分：有盲评分用盲评分，没有就对存档稿子补跑一次盲评通道 */
async function newDimScores(s: PoolSample, newDims: DimKey[], dataDir: string | undefined, deps: BumpDeps): Promise<{ scores: DimScores; backfilled: boolean }> {
  const missing = newDims.filter((d) => typeof s.prediction.scores.blind?.[d] !== "number");
  const scores: DimScores = { ...s.prediction.scores.final };
  for (const d of newDims) if (typeof s.prediction.scores.blind?.[d] === "number") scores[d] = s.prediction.scores.blind[d];
  if (!missing.length) return { scores, backfilled: false };
  const run = await latestBlindRun(s.prediction.blind_run_id, dataDir);
  if (!run) throw new Error(`样本 ${s.prediction.id} 的稿子存档不见了，没法补打分`);
  const { rubric } = await ensureCalibration(dataDir);
  const b = await runBlindChannel(run.script_text, rubric, dataDir, { runLoopImpl: deps.blindLoop });
  for (const d of missing) scores[d] = b.scores[d].score;
  return { scores, backfilled: true };
}

export async function buildGateSamples(pool: PoolSample[], oldF: RubricFormula, newF: RubricFormula, dataDir: string | undefined, deps: BumpDeps) {
  const newDims = (Object.keys(newF.weights) as DimKey[]).filter((d) => !(d in oldF.weights));
  const samples: Array<GateSample & { scores: DimScores; backfilled: boolean }> = [];
  for (const s of pool) {
    const { scores, backfilled } = await newDimScores(s, newDims, dataDir, deps);
    samples.push({ id: s.prediction.id, label: s.prediction.title, oldScore: composite(s.prediction.scores.final, oldF) ?? s.prediction.composite,
      newScore: composite(scores, newF) as number, actual: s.actual, scores, backfilled });
  }
  return { samples, newDims };
}

export function auditPayload(oldText: string, newText: string, pool: PoolSample[], gate: RankGateResult): string {
  const rows = pool.map((s) => ({ id: s.prediction.id, title: s.prediction.title, scores: s.prediction.scores.final, actual: s.retro.actual }));
  return `旧公式：${oldText}\n新公式：${newText}\n\n校准池（维度分、实绩）：\n${JSON.stringify(rows)}\n\n排序对照：\n${JSON.stringify({ table: gate.table, spearman: gate.spearman, consistency: gate.consistency, regressions: gate.regressions })}`;
}

export async function proposeBump(args: Obj, dataDir?: string, deps: BumpDeps = {}): Promise<Obj> {
  const { state, rubric } = await ensureCalibration(dataDir);
  const pool = await calibrationPool(dataDir);
  const blocked = proposalGate(state, pool.length, args);
  if (blocked) return { ok: false, code: "bump_not_allowed", error: blocked };
  const formula = readFormula(args.formula);
  const newText = formulaText(formula);
  const { samples, newDims } = await buildGateSamples(pool, rubric.formula, formula, dataDir, deps);
  const gate = rankGate(samples);
  const base = { from: rubric.version, old_formula: rubric.formula_text, new_formula: newText, kind: args.kind, rationale: args.rationale, gate };
  if (!gate.pass) return recordRejection({ ...base, step: 3, reason: gate.reasons.join("；") }, dataDir);
  const audit = await runAudit(auditPayload(rubric.formula_text, newText, pool, gate), dataDir, { runLoopImpl: deps.auditLoop });
  if (audit.verdict !== "PASS") return recordRejection({ ...base, step: 4, reason: audit.verdict === "REJECT" ? "本地 PASS + 审计 REJECT，视为 REJECT" : audit.reason, audit }, dataDir);
  return applyBump({ ...base, formula, newDims, samples, audit, args }, dataDir);
}
