/**
 * 排序门（bump-validation-protocol.md Step 3），通用：只认 {id, 旧分, 新分, 实绩}。
 * 评分表升级、以后的标题方法库留删改都过同一道门。
 *   一致性 = |新排名 − 实绩排名| ≤ 1 的样本占比，≥ 80%（写死）；
 *   逐对不倒序 = 旧分排对的任一对，新分不能排反（新分打平也算没守住——从严）；
 *   另报 Spearman 供审计参考。
 */
import { BUMP_RULES } from "./constants.js";

export interface GateSample { id: string; label?: string; oldScore: number; newScore: number; actual: number }
export interface RankRow { id: string; label?: string; old_score: number; new_score: number; rank_new: number; actual: number; rank_actual: number; delta: number }
export interface RankGateResult {
  pass: boolean; spearman: number | null; consistency: number; threshold: number;
  regressions: Array<[string, string]>; table: RankRow[]; reasons: string[];
}

/** 降序排名，并列取平均名次 */
export function ranks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const out = new Array<number>(values.length);
  for (let k = 0; k < order.length;) {
    let j = k;
    while (j + 1 < order.length && order[j + 1].v === order[k].v) j++;
    for (let t = k; t <= j; t++) out[order[t].i] = (k + j) / 2 + 1;
    k = j + 1;
  }
  return out;
}

/** Spearman = 名次上的 Pearson（并列名次时也正确）；方差为 0 → null */
export function spearman(a: number[], b: number[]): number | null {
  const ra = ranks(a), rb = ranks(b);
  const n = ra.length;
  if (n < 2) return null;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { cov += (ra[i] - ma) * (rb[i] - mb); va += (ra[i] - ma) ** 2; vb += (rb[i] - mb) ** 2; }
  return va === 0 || vb === 0 ? null : Math.round((cov / Math.sqrt(va * vb)) * 1000) / 1000;
}

const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** 旧分排对（与实绩同向、严格）的对，新分没守住的列出来 */
export function pairwiseRegressions(samples: GateSample[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i], b = samples[j];
      const truth = sign(a.actual - b.actual);
      if (truth === 0 || sign(a.oldScore - b.oldScore) !== truth) continue;
      if (sign(a.newScore - b.newScore) !== truth) out.push([a.id, b.id]);
    }
  }
  return out;
}

export function rankGate(samples: GateSample[]): RankGateResult {
  const rn = ranks(samples.map((s) => s.newScore));
  const ra = ranks(samples.map((s) => s.actual));
  const table = samples.map((s, i) => ({ id: s.id, label: s.label, old_score: s.oldScore, new_score: s.newScore, rank_new: rn[i], actual: s.actual, rank_actual: ra[i], delta: Math.abs(rn[i] - ra[i]) }));
  const consistency = samples.length ? table.filter((r) => r.delta <= BUMP_RULES.RANK_DELTA_TOLERANCE).length / samples.length : 0;
  const regressions = pairwiseRegressions(samples);
  const reasons: string[] = [];
  if (samples.length < 2) reasons.push("样本不足 2 个，排不了序");
  if (consistency < BUMP_RULES.THRESHOLD) reasons.push(`排序一致性 ${(consistency * 100).toFixed(0)}% < ${BUMP_RULES.THRESHOLD * 100}%`);
  if (regressions.length) reasons.push(`旧公式排对的 ${regressions.length} 对被新公式排反或打平`);
  return { pass: reasons.length === 0, spearman: spearman(samples.map((s) => s.newScore), samples.map((s) => s.actual)), consistency, threshold: BUMP_RULES.THRESHOLD, regressions, table, reasons };
}
