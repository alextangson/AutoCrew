/**
 * 发布回执 ↔ 发布前把关（发布审查闸门 spec §11、E15）：每条可信发布观察 / 创始人「我发了」在**写入时**盖一次把关结论——
 * 引用该平台的 check_id（计划条目带的；没带就找提交前最近的一次），有效 = 检查早于提交、平台对、当时没有未例外的拦截。
 * 找不到 → 「发布前未把关」；检查里的原话例外 → 「发布前例外：『原话』」。结论随事实不可变，事后补跑的检查抹不掉。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { GateStamp } from "../../storage/production-types.js";
import { checksDir, readCheckRecord } from "../publish/review-gate/check-store.js";

interface CheckRec { check_id?: string; platform?: string; checked_at?: string; verdict?: string; inputs?: { overrides?: Array<{ founder_quote?: string }> } }

const quotesOf = (r: CheckRec) => (r.inputs?.overrides ?? []).map((o) => o.founder_quote ?? "").filter(Boolean);

function valid(r: CheckRec | null, platform: string, before: number): r is CheckRec {
  return Boolean(r && r.platform === platform && r.verdict !== "block" && r.checked_at && Date.parse(r.checked_at) <= before);
}

/** 这个平台、这个提交时刻之前最近的一次有效检查 */
async function latestValid(contentId: string, platform: string, before: number, dataDir: string): Promise<CheckRec | null> {
  let dir: string;
  try { dir = checksDir(contentId, dataDir); } catch { return null; }
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(`chk-`) && n.endsWith(".json") && n.includes(`-${platform}-`));
  let best: CheckRec | null = null;
  for (const n of names) {
    const r = JSON.parse(await fs.readFile(path.join(dir, n), "utf8").catch(() => "null")) as CheckRec | null;
    if (valid(r, platform, before) && (!best || Date.parse(r.checked_at!) > Date.parse(best.checked_at!))) best = r;
  }
  return best;
}

/** 写入时盖一次：`submittedAt` = 提交 / 发布证据时间，没有就按现在 */
export async function gateStamp(contentId: string, platform: string, submittedAt: string | undefined, checkId: string | undefined, dataDir: string): Promise<GateStamp> {
  const before = submittedAt && !Number.isNaN(Date.parse(submittedAt)) ? Math.min(Date.parse(submittedAt), Date.now()) : Date.now();
  if (checkId) {
    const r = (await readCheckRecord(contentId, checkId, dataDir).catch(() => null)) as CheckRec | null;
    if (valid(r, platform, before)) return { ok: true, check_id: checkId, overrides: quotesOf(r) };
    return { ok: false, check_id: checkId, overrides: [], note: "引用的检查不在、平台不对、晚于提交或当时被拦" };
  }
  const r = await latestValid(contentId, platform, before, dataDir);
  return r ? { ok: true, check_id: r.check_id, overrides: quotesOf(r) } : { ok: false, overrides: [], note: "发布前没有有效的检查" };
}
