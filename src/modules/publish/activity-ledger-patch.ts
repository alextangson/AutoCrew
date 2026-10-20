/**
 * activity_record 的合并语义：按 key 合到已有记录上。没传的字段保留旧值；window / rules / form 按子字段合；
 * 显式 null 清空（清空也进 diff 和 history）。每次都必须带 verified_at + sources；新建才要求 platform / name / official_url。
 */
import { maybeJson, UNPARSABLE } from "./review-gate/plan.js";
import { ACTIVITY_PLATFORMS, activityKey, listParam, nestedTypeProblem, type ActivityRecord } from "./activity-ledger.js";

type Obj = Record<string, unknown>;
const NESTED = ["window", "rules", "form"] as const;
const SCALARS = ["name", "platform_activity_id", "official_url", "relevance", "reason", "verified_via"] as const;
export interface RecordPatch { key?: string; platform?: string; fields: Obj; founder_quote?: string }
type R<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
function isHttp(u: string): boolean { try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; } }

/** 只收传了的字段；null 原样保留表示清空。类型不对的拒 */
export function parsePatch(o: Obj): R<RecordPatch> {
  const verifiedAt = str(o.verified_at);
  if (!verifiedAt || Number.isNaN(Date.parse(verifiedAt))) return { ok: false, error: "verified_at 每次必填：带时区的核查时间（ISO 8601）" };
  const sources = listParam(o.sources);
  if (sources === UNPARSABLE) return { ok: false, error: "sources 看着是 JSON，但修过引号也解析不了" };
  if (!sources.length) return { ok: false, error: "sources 每次必填：本次核查依据的页面（至少一条）" };
  const fields: Obj = { verified_at: verifiedAt, sources };
  for (const k of SCALARS) {
    if (!has(o, k)) continue;
    if (o[k] === null) {
      if (k === "relevance") return { ok: false, error: "relevance 不能清空：取值 fits_us / not_for_us" };
      fields[k] = null; continue;
    }
    const v = str(o[k]);
    if (!v) return { ok: false, error: `${k} 要是非空字符串（清空请传 null）` };
    fields[k] = v;
  }
  if (typeof fields.official_url === "string" && !isHttp(fields.official_url)) return { ok: false, error: "official_url 要是 http(s) 地址" };
  if (has(fields, "relevance") && !["fits_us", "not_for_us", null].includes(fields.relevance as string | null)) return { ok: false, error: "relevance 取值 fits_us / not_for_us" };
  for (const k of NESTED) {
    if (!has(o, k)) continue;
    const v = o[k] === null ? null : maybeJson(o[k]);
    if (v === UNPARSABLE) return { ok: false, error: `${k} 看着是 JSON，但修过引号也解析不了` };
    if (v !== null && !isObj(v)) return { ok: false, error: `${k} 要是 JSON 对象（清空请传 null）` };
    const problem = v === null ? null : nestedTypeProblem(k, v, true);
    if (problem) return { ok: false, error: problem };
    fields[k] = v;
  }
  if (has(o, "evidence")) {
    if (o.evidence === null) fields.evidence = null;
    else {
      const e = listParam(o.evidence);
      if (e === UNPARSABLE) return { ok: false, error: "evidence 看着是 JSON，但修过引号也解析不了（清空请传 null）" };
      if (e.some((x) => typeof x !== "string")) return { ok: false, error: "evidence 要是文件路径字符串数组" };
      fields.evidence = e;
    }
  }
  const platform = str(o.platform);
  if (platform && !(ACTIVITY_PLATFORMS as readonly string[]).includes(platform)) return { ok: false, error: `platform 取值 ${ACTIVITY_PLATFORMS.join(" / ")}` };
  return { ok: true, value: { key: str(o.key), platform, fields, founder_quote: str(o.founder_quote) } };
}

/** 这次写的是哪个 key：给了 key 用 key；否则 platform + (平台活动 ID | 规范化名称) */
export function patchKey(p: RecordPatch): R<string> {
  if (p.key) return { ok: true, value: p.key };
  const name = p.fields.name;
  if (!p.platform || typeof name !== "string") return { ok: false, error: "要么带 key 更新已有活动，要么带 platform + name（新建还要 official_url）" };
  const id = typeof p.fields.platform_activity_id === "string" ? p.fields.platform_activity_id : undefined;
  return { ok: true, value: activityKey(p.platform, name, id) };
}

function mergeNested(prev: unknown, patch: Obj | null): Obj | undefined {
  if (patch === null) return undefined;
  const out: Obj = { ...(isObj(prev) ? prev : {}) };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else if (v !== undefined) out[k] = v; }
  return Object.keys(out).length ? out : undefined;
}

/** 合并出新记录（history 由调用方追加）。新建缺必填、not_for_us 缺理由都拒 */
export function mergeRecord(prev: ActivityRecord | undefined, key: string, p: RecordPatch): R<ActivityRecord> {
  if (!prev) {
    if (p.key && !p.platform) return { ok: false, error: `台账里没有 ${p.key}：新建要带 platform、name、official_url` };
    for (const k of ["name", "official_url"]) if (typeof p.fields[k] !== "string") return { ok: false, error: `新建活动 ${k} 必填` };
    if (!p.platform) return { ok: false, error: "新建活动 platform 必填" };
  }
  const next: Obj = { ...(prev ?? { platform: p.platform, relevance: "fits_us", history: [] }), key };
  for (const [k, v] of Object.entries(p.fields)) {
    if ((NESTED as readonly string[]).includes(k)) next[k] = mergeNested(next[k], v as Obj | null);
    else if (k === "evidence" && v !== null) next.evidence = [...new Set([...((next.evidence as string[]) ?? []), ...(v as string[])])];
    else if (v === null) delete next[k];
    else next[k] = v;
  }
  for (const k of ["name", "official_url"]) if (typeof next[k] !== "string") return { ok: false, error: `${k} 不能清空：台账每条都要有` };
  if (!next.relevance) next.relevance = "fits_us";
  if (next.relevance === "not_for_us" && !str(next.reason)) return { ok: false, error: "not_for_us 必须带 reason（账号层面的排除理由）" };
  if (next.relevance === "fits_us" && prev?.relevance === "not_for_us" && !has(p.fields, "reason")) delete next.reason;
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  return { ok: true, value: next as unknown as ActivityRecord };
}
