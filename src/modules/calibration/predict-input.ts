/**
 * 预测主体的入参校验（系统边界：宿主模型传来的参数，数组/对象可能是 JSON 串）。
 * 只校验结构与 cheat-on 的硬约束（5 档概率合计 100、headline=最高档、中枢落在本档、冷启动更平）。
 */
import { decodeArg } from "../meetings/meeting-args.js";
import { COLD_START_MAX_PROB, COLD_START_SAMPLES, DISAGREEMENT_THRESHOLD } from "./constants.js";
import type { Bucket } from "./derive.js";
import { ALL_DIMS, type DimKey, type DimScores } from "./rubric.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown, field: string): Obj => {
  const d = decodeArg(v);
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`${field} 必须是对象`);
  return d as Obj;
};
const list = (v: unknown, field: string): unknown[] => {
  const d = decodeArg(v);
  if (!Array.isArray(d)) throw new Error(`${field} 必须是数组`);
  return d.map((x) => decodeArg(x));
};
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** 主通道自评：全部 9 维 0–5 整数 */
export function readDimScores(raw: unknown, field: string): DimScores {
  const o = obj(raw, field);
  const out: DimScores = {};
  for (const d of ALL_DIMS) {
    const s = typeof o[d] === "string" ? Number(o[d]) : o[d];
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > 5) throw new Error(`${field}.${d} 必须是 0–5 整数（全部维度都要打，含候选维度 MS、TS）`);
    out[d] = s;
  }
  return out;
}

export interface DisagreementRow { dim: DimKey; blind: number | null; self: number; delta: number | null; decided_as?: string }

export function disagreementTable(blind: DimScores | null, self: DimScores): DisagreementRow[] {
  return ALL_DIMS.map((dim) => {
    const b = blind?.[dim] ?? null;
    return { dim, blind: b, self: self[dim] as number, delta: b === null ? null : Math.abs(b - (self[dim] as number)) };
  });
}

/** 分歧 ≥ 阈值的维度必须有创始人裁定：blind / self / 0–5 自己给分 */
export function applyDecisions(rows: DisagreementRow[], raw: unknown): { final: DimScores; rows: DisagreementRow[]; override: boolean } {
  const decisions = raw === undefined || raw === null ? {} : obj(raw, "decisions");
  const final: DimScores = {};
  let override = false;
  const out = rows.map((r) => {
    const d = decisions[r.dim];
    if (r.blind === null) { final[r.dim] = r.self; return { ...r, decided_as: "self" }; }
    if (d === undefined) {
      if ((r.delta ?? 0) >= DISAGREEMENT_THRESHOLD) throw new Error(`${r.dim} 盲评 ${r.blind} vs 主通道 ${r.self} 差 ${r.delta}：先把这维摆给创始人选「信盲评 / 信主通道 / 自己给分」，填进 decisions.${r.dim}`);
      final[r.dim] = r.blind; return { ...r, decided_as: "blind" };
    }
    const n = typeof d === "string" && /^\d$/.test(d) ? Number(d) : d;
    if (n === "blind") { final[r.dim] = r.blind; return { ...r, decided_as: "blind" }; }
    if (n === "self") { override = true; final[r.dim] = r.self; return { ...r, decided_as: "self" }; }
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 5) { override = true; final[r.dim] = n; return { ...r, decided_as: `user:${n}` }; }
    throw new Error(`decisions.${r.dim} 只能是 "blind" / "self" / 0–5 整数`);
  });
  return { final, rows: out, override };
}

export interface PredictionBody { bucket: string; distribution: Record<string, number>; center: number; reason: string }

export function readPredictionBody(raw: unknown, buckets: Bucket[], samples: number): PredictionBody {
  const o = obj(raw, "prediction");
  const bucket = text(o.bucket);
  const b = buckets.find((x) => x.name === bucket);
  if (!b) throw new Error(`prediction.bucket 只能是 ${buckets.map((x) => x.name).join(" / ")}`);
  const dist = obj(o.distribution, "prediction.distribution");
  const distribution: Record<string, number> = {};
  for (const x of buckets) {
    const p = Number(dist[x.name]);
    if (!Number.isInteger(p) || p < 0 || p > 100) throw new Error(`distribution.${x.name} 要 0–100 的整数百分比（5 档都要给）`);
    distribution[x.name] = p;
  }
  const sum = Object.values(distribution).reduce((a, c) => a + c, 0);
  if (sum !== 100) throw new Error(`概率分布合计 ${sum}%，必须正好 100%`);
  const max = Math.max(...Object.values(distribution));
  if (distribution[bucket] !== max) throw new Error(`headline bucket「${bucket}」不是概率最高的那档`);
  if (samples < COLD_START_SAMPLES && max > COLD_START_MAX_PROB) throw new Error(`冷启动期（校准样本 ${samples}）分布要更平：最高一档不超过 ${COLD_START_MAX_PROB}%`);
  const center = Number(o.center);
  if (!Number.isFinite(center) || center < b.min || (b.max !== null && center >= b.max)) throw new Error(`中枢 ${String(o.center)} 不在「${bucket}」的范围 [${b.min}, ${b.max ?? "∞"}) 内`);
  const reason = text(o.reason);
  if (!reason) throw new Error("prediction.reason 要一句话理由");
  return { bucket, distribution, center, reason };
}

export interface Factor { factor: string; direction: "+" | "-"; confidence: "高" | "中" | "低"; note: string }

export function readFactors(raw: unknown): Factor[] {
  const items = list(raw, "factors");
  if (!items.length) throw new Error("factors 至少一条推理因素");
  return items.map((x, i) => {
    const f = (x && typeof x === "object" ? x : {}) as Obj;
    const direction = text(f.direction);
    const confidence = text(f.confidence);
    if (!text(f.factor) || !["+", "-"].includes(direction) || !["高", "中", "低"].includes(confidence)) {
      throw new Error(`factors[${i}] 要 {factor, direction:"+"|"-", confidence:"高"|"中"|"低", note}`);
    }
    return { factor: text(f.factor), direction: direction as "+" | "-", confidence: confidence as Factor["confidence"], note: text(f.note) };
  });
}

/** 反事实：每个 bucket 一段「落在这里意味着什么」 */
export function readCounterfactuals(raw: unknown, buckets: Bucket[]): Record<string, string> {
  const o = obj(raw, "counterfactuals");
  const out: Record<string, string> = {};
  for (const b of buckets) {
    if (!text(o[b.name])) throw new Error(`counterfactuals.${b.name} 缺：每个 bucket 都要写落在这里意味着什么`);
    out[b.name] = text(o[b.name]);
  }
  return out;
}

export function requireText(v: unknown, field: string): string {
  const t = text(v);
  if (!t) throw new Error(`${field} 必填`);
  return t;
}
