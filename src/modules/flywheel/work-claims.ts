/**
 * 无作品编号行的人工认领（老作品补齐规格 2026-10-04 ①）。
 *
 * 抖音 CSV、B 站导出的行没有平台作品 id，人工绑定（work_bind）够不着。这里按
 * 「平台 + 归一化标题 @ 北京发布日」这一组认领到某篇稿：
 * - 认领表 `<dataDir>/work-claims.json` 记下归属（人确认过的精确事实），以后同组的新快照入账时直接认到这篇；
 * - 已入账的同组行按新归属各补一条（append-only，不改旧行）；
 * - 同组已归属别的稿 → 拒绝并报出现有归属；重复执行幂等；删历史记录时一并撤销。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { normalizePlatform, normalizeTitle, shanghaiDate, isTruncatedItemId, outcomeKey, ATTRIBUTION_REVIEW_PREFIX, type PerformanceOutcome } from "./outcome-schema.js";
import { appendOutcomes, latestByKey, serializeOutcomeWrite } from "./outcome-store.js";

const CLAIMS_FILE = "work-claims.json";
const SCHEMA_VERSION = 1;
/** 与 work-binding 的 BINDABLE_PLATFORMS 一致（不从那里引，免得循环依赖） */
const CLAIMABLE_PLATFORMS: readonly string[] = ["douyin", "wechat_video", "xiaohongshu", "bilibili", "wechat_mp"];

export interface WorkClaim { contentId: string; title: string; date: string; claimedAt: string; via: "manual_claim" }
interface ClaimsFile { schemaVersion: number; claims: Record<string, WorkClaim> }

const claimsPath = (dataDir?: string) => path.join(getDataDir(dataDir), CLAIMS_FILE);

/** 组键：平台 : 归一化标题 @ 北京发布日 */
export function claimKey(platform: string, title: string, date: string): string {
  return `${normalizePlatform(platform)}:${normalizeTitle(title)}@${date}`;
}

/** 严格读：不存在 = 空表；读不出 / 坏 → 抛（不拿空表覆盖人确认过的认领） */
export async function readClaimsStrict(dataDir?: string): Promise<Record<string, WorkClaim>> {
  let raw: string;
  try { raw = await fs.readFile(claimsPath(dataDir), "utf-8"); } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    throw new Error(`认领表 work-claims.json 读不出（${(err as Error).message}）——已停下，没有改动`);
  }
  let parsed: ClaimsFile | null = null;
  try { parsed = JSON.parse(raw) as ClaimsFile; } catch { parsed = null; }
  const ok = parsed && parsed.schemaVersion === SCHEMA_VERSION && parsed.claims && typeof parsed.claims === "object" && !Array.isArray(parsed.claims)
    && Object.values(parsed.claims).every((c) => c && typeof c.contentId === "string");
  if (!ok) throw new Error("认领表 work-claims.json 损坏或版本不认——已停下，没有改动；请人工检查或从备份恢复");
  return parsed!.claims;
}

/** 入账时查认领（宽松：表坏了只 warn，退回原来的标题匹配，不挡入账） */
export async function lookupClaim(platform: string, title: string, publishedAt: string | null, dataDir?: string): Promise<WorkClaim | null> {
  if (!publishedAt || !normalizeTitle(title)) return null;
  try {
    return (await readClaimsStrict(dataDir))[claimKey(platform, title, shanghaiDate(publishedAt))] ?? null;
  } catch (err) {
    console.warn(`[flywheel] ${(err as Error).message}——本次入账不按认领归属`);
    return null;
  }
}

const claimChains = new Map<string, Promise<unknown>>();
function serializeClaimWrite<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = getDataDir(dataDir);
  const next = (claimChains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  claimChains.set(key, tail);
  void tail.then(() => { if (claimChains.get(key) === tail) claimChains.delete(key); });
  return next;
}

async function writeClaims(claims: Record<string, WorkClaim>, dataDir?: string): Promise<void> {
  await fs.mkdir(getDataDir(dataDir), { recursive: true });
  await writeJsonAtomic(claimsPath(dataDir), { schemaVersion: SCHEMA_VERSION, claims } satisfies ClaimsFile);
}

/** 删掉某稿的全部认领（删历史记录时用）。返回删掉的组键 */
export async function removeClaimsForContent(contentId: string, dataDir?: string): Promise<string[]> {
  return serializeClaimWrite(dataDir, async () => {
    const claims = await readClaimsStrict(dataDir);
    const removed = Object.keys(claims).filter((k) => claims[k].contentId === contentId);
    if (removed.length === 0) return [];
    for (const k of removed) delete claims[k];
    await writeClaims(claims, dataDir);
    return removed;
  });
}

export type ClaimResult =
  | { ok: true; status: "claimed" | "already"; key: string; platform: string; copied: number }
  | { ok: false; error: string; existing?: { contentId: string; key: string } };

interface ClaimInput { contentId: string; platform: string; title: string; date: string }

function parseClaim(contentId: string, platformRaw: unknown, titleRaw: unknown, dateRaw: unknown): { ok: true; input: ClaimInput } | { ok: false; error: string } {
  const platform = typeof platformRaw === "string" ? normalizePlatform(platformRaw.trim()) : "";
  if (!CLAIMABLE_PLATFORMS.includes(platform)) return { ok: false, error: `平台「${String(platformRaw ?? "")}」不认识，只能是 ${CLAIMABLE_PLATFORMS.join(" / ")}（xhs 也认）` };
  const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
  if (!normalizeTitle(title)) return { ok: false, error: "认领需要平台上的作品标题（title）" };
  const date = typeof dateRaw === "string" ? dateRaw.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { ok: false, error: `发布日期「${String(dateRaw ?? "")}」不是 YYYY-MM-DD（按北京时间的发布日）` };
  return { ok: true, input: { contentId, platform, title, date } };
}

const groupOf = (o: PerformanceOutcome) => outcomeKey({ ...o, contentId: null, metricDate: "" });
const trustedId = (o: PerformanceOutcome) => !!o.platformItemId?.trim() && !isTruncatedItemId(o.platform, o.platformItemId);

function cleaned(r: PerformanceOutcome): Pick<PerformanceOutcome, "needsReview" | "reviewReasons"> {
  const reviewReasons = (r.reviewReasons ?? []).filter((x) => !x.startsWith(ATTRIBUTION_REVIEW_PREFIX));
  return { reviewReasons, needsReview: reviewReasons.length > 0 };
}

/**
 * 稿件 id + 平台 + 标题 + 发布日期 → 认领这组无编号行。先查后写：任何冲突都一行不写。
 */
export async function claimWorkByTitle(contentId: string, platformRaw: unknown, titleRaw: unknown, dateRaw: unknown, dataDir?: string): Promise<ClaimResult> {
  const content = contentId ? await getContent(contentId, dataDir) : null;
  if (!content || content.deletedAt) return { ok: false, error: `稿子 id「${contentId}」不存在` };
  const parsed = parseClaim(content.id, platformRaw, titleRaw, dateRaw);
  if (!parsed.ok) return parsed;
  try { assertDataDirWritable(dataDir); } catch (err) { return { ok: false, error: (err as Error).message }; }
  return serializeOutcomeWrite(dataDir, () => serializeClaimWrite(dataDir, () => claimLocked(parsed.input, dataDir)));
}

async function claimLocked(input: ClaimInput, dataDir?: string): Promise<ClaimResult> {
  const { contentId, platform, title, date } = input;
  const key = claimKey(platform, title, date);
  const where = `${platform}「${title}」@${date}`;
  let claims: Record<string, WorkClaim>;
  try { claims = await readClaimsStrict(dataDir); } catch (err) { return { ok: false, error: (err as Error).message }; }
  const held = claims[key];
  if (held && held.contentId !== contentId) {
    return { ok: false, error: `${where} 已认领给稿子 ${held.contentId}（${held.claimedAt}）——不覆盖，要改先删掉那条历史记录或撤认领`, existing: { contentId: held.contentId, key } };
  }
  const latest = await latestByKey(dataDir);
  const norm = normalizeTitle(title);
  const group = [...latest.values()].filter((o) => o.platform === platform && normalizeTitle(o.platformTitle) === norm && !!o.publishedAt && shanghaiDate(o.publishedAt) === date);
  if (group.some(trustedId)) return { ok: false, error: `${where} 这组行带平台作品 id——请用 work_bind 按 id 精确绑定` };
  if (group.length === 0) return { ok: false, error: `${where} 在已入账的回流行里没找到（标题要和平台上的完全一致，日期按北京时间）` };
  const other = group.find((o) => o.contentId !== null && o.contentId !== contentId);
  if (other) return { ok: false, error: `${where} 已归属稿子 ${other.contentId}——不覆盖`, existing: { contentId: other.contentId!, key } };

  const recordedAt = new Date().toISOString();
  const out: PerformanceOutcome[] = [];
  for (const date of [...new Set(group.map((r) => r.metricDate))]) {
    const pool = group.filter((r) => r.metricDate === date);
    const newest = pool.reduce((a, b) => (b.recordedAt > a.recordedAt ? b : a));
    if (newest.contentId === contentId) continue;
    const copy: PerformanceOutcome = { ...newest, contentId, recordedAt, ...cleaned(newest) };
    const dest = latest.get(outcomeKey(copy));
    if (dest && groupOf(dest) !== groupOf(newest)) {
      return { ok: false, error: `稿子 ${contentId} 在 ${platform} ${date} 已有另一条作品「${dest.platformTitle.split("\n")[0]}」的数据，不覆盖——先确认这两条哪条属于这篇稿` };
    }
    if (dest) continue; // 同组已有本稿快照：上次认领过
    out.push(copy);
  }
  if (!held) {
    claims[key] = { contentId, title, date, claimedAt: recordedAt, via: "manual_claim" };
    await writeClaims(claims, dataDir);
  }
  await appendOutcomes(out, dataDir);
  return { ok: true, status: held ? "already" : "claimed", key, platform, copied: out.length };
}
