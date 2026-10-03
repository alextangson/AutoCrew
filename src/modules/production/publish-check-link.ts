/**
 * 发布回执 ↔ 发布前把关（发布审查闸门 spec §11、E15）：每条可信发布观察 / 创始人「我发了」在**写入时**盖一次把关结论——
 * 引用该平台的 check_id（计划条目带的；没带就找提交前最近的一次），有效 = 检查早于提交、平台对、当时没有未例外的拦截。
 * 找不到 → 「发布前未把关」；检查里的原话例外 → 「发布前例外：『原话』」。结论随事实不可变，事后补跑的检查抹不掉。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GateStamp } from "../../storage/production-types.js";
import { DERIVE_VERSION, readEnabledMarker } from "../../storage/production-store.js";
import { checksDir, readCheckRecord } from "../publish/review-gate/check-store.js";

interface CheckRec { check_id?: string; platform?: string; checked_at?: string; verdict?: string; payload_hash?: string; inputs?: { overrides?: Array<{ founder_quote?: string }> } }

const quotesOf = (r: CheckRec) => (r.inputs?.overrides ?? []).map((o) => o.founder_quote ?? "").filter(Boolean);

function valid(r: CheckRec | null, platform: string, before: number): r is CheckRec {
  return Boolean(r && r.platform === platform && r.verdict !== "block" && r.checked_at && Date.parse(r.checked_at) <= before);
}

/** 这个平台、这个提交时刻之前最近的一次有效检查 */
async function latestValid(contentId: string, platform: string, before: number, dataDir: string, ok: (r: CheckRec) => boolean): Promise<CheckRec | null> {
  let dir: string;
  try { dir = checksDir(contentId, dataDir); } catch { return null; }
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(`chk-`) && n.endsWith(".json") && n.includes(`-${platform}-`));
  let best: CheckRec | null = null;
  for (const n of names) {
    const r = JSON.parse(await fs.readFile(path.join(dir, n), "utf8").catch(() => "null")) as CheckRec | null;
    if (valid(r, platform, before) && ok(r) && (!best || Date.parse(r.checked_at!) > Date.parse(best.checked_at!))) best = r;
  }
  return best;
}

/**
 * 写入时盖一次（创始人 09-29 定：严格）。有效 = 有**实际提交时间**（计划里的 submitted_at / 授权时间；定时公开时间不算、没有也不算），
 * 检查早于它、平台对、当时没被拦，且检查的 payload 哈希 = 计划里实际提交的那份条目（`payload` 由调用方按计划算）。
 * 提交早于本体启用（闸门还不存在）→ applies=false，不标未把关；`evidenceAt`（公开 / 定时时间，只会晚于提交）早于启用也算。
 */
export async function gateStamp(contentId: string, platform: string, submittedAt: string | undefined, checkId: string | undefined, dataDir: string, evidenceAt?: string, payload?: string | null): Promise<GateStamp> {
  const submitted = submittedAt && !Number.isNaN(Date.parse(submittedAt)) ? Date.parse(submittedAt) : NaN;
  const evidence = evidenceAt ? Date.parse(evidenceAt) : NaN;
  const latestSubmit = Math.min(...[submitted, evidence, Date.now()].filter((x) => !Number.isNaN(x)));
  const marker = await readEnabledMarker(dataDir).catch(() => null);
  const applies = Boolean(marker && marker.version === DERIVE_VERSION && Date.parse(marker.enabledAt) <= latestSubmit);
  const base = { applies, ...(Number.isNaN(submitted) ? {} : { submitted_at: new Date(submitted).toISOString() }) };
  if (Number.isNaN(submitted)) return { ok: false, overrides: [], note: applies ? "发布计划里没有实际提交时间（只有定时时间或什么都没有），证明不了检查早于提交" : "本体启用前发布，当时还没有发布前把关", ...base, ...(checkId ? { check_id: checkId } : {}) };
  const matches = (r: CheckRec) => Boolean(payload) && r.payload_hash === payload;
  if (checkId) {
    const r = (await readCheckRecord(contentId, checkId, dataDir).catch(() => null)) as CheckRec | null;
    if (valid(r, platform, submitted) && matches(r)) return { ok: true, check_id: checkId, overrides: quotesOf(r), ...base };
    return { ok: false, check_id: checkId, overrides: [], note: "引用的检查不在、平台不对、晚于提交、当时被拦，或检查的不是实际提交的那份", ...base };
  }
  const r = await latestValid(contentId, platform, submitted, dataDir, matches);
  return r ? { ok: true, check_id: r.check_id, overrides: quotesOf(r), ...base }
    : { ok: false, overrides: [], note: applies ? "发布前没有检查过实际提交的那份" : "本体启用前发布，当时还没有发布前把关", ...base };
}

/** 该标「发布前未把关」：闸门存在之后提交、且没有有效检查。旧版（没有 applies 字段）的结论不标 */
export const isUngated = (g: GateStamp | undefined): boolean => Boolean(g && g.applies === true && !g.ok);

/** 发布计划里这个平台的实际提交证据：提交时间、带的 check_id、提交那份条目的 payload 哈希 */
export async function planSubmission(contentId: string, platform: string, dataDir: string): Promise<{ submittedAt?: string; checkId?: string; evidenceAt?: string; payload: string | null }> {
  const { readPublishRecord } = await import("../../storage/publish-record.js");
  const { normalizePlatform } = await import("../publish/review-gate/platforms.js");
  const { entryPayloadHash } = await import("../publish/review-gate/check.js");
  const record = await readPublishRecord(contentId, undefined, dataDir).catch(() => ({ kind: "none" as const }));
  const p = record.kind === "none" ? undefined : record.platforms.find((x) => (normalizePlatform(x.platform) ?? x.platform) === platform);
  return { ...(p?.submittedAt ? { submittedAt: p.submittedAt } : {}), ...(p?.checkId ? { checkId: p.checkId } : {}), ...(p?.evidenceAt ?? p?.time ? { evidenceAt: (p.evidenceAt ?? p.time)! } : {}),
    payload: p ? await entryPayloadHash(contentId, platform, dataDir).catch(() => null) : null };
}

/** 按计划里的提交证据盖章（创始人「我发了」、确认 AI 说法、可信观察都走这一条） */
export async function gateFromPlan(contentId: string, platform: string, dataDir: string): Promise<GateStamp> {
  const s = await planSubmission(contentId, platform, dataDir);
  return gateStamp(contentId, platform, s.submittedAt, s.checkId, dataDir, s.evidenceAt, s.payload);
}
