/**
 * 活动台账落盘：<dataDir>/platform-activities.json。缺文件 = 空台账；坏文件 = 报错带路径，绝不当空（边界 2）。
 * 写入走进程内按文件排队 + 跨进程锁文件 + 锁内重读再按 key 合并 + 原子落盘（边界 7）；资料库写入权由 writeJsonAtomicMkdir 内的受管路径检查把关。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { assertManagedPathAvailable } from "../../storage/storage-roots.js";
import { withFileLock } from "./activity-ledger-lock.js";
import { parsePlan } from "./review-gate/plan.js";
import { normalizePlatform } from "./review-gate/platforms.js";
import {
  freshnessOf, normalizeName, recordShapeProblem, ruleDiff,
  type ActivityRecord, type Freshness, type HistoryEntry, type Ledger,
} from "./activity-ledger.js";
import { mergeRecord, patchKey, type RecordPatch } from "./activity-ledger-patch.js";

export const LEDGER_FILE = "platform-activities.json";
export class LedgerCorruptError extends Error {}

export function ledgerPath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), LEDGER_FILE);
}

export async function readLedger(dataDir?: string): Promise<Ledger> {
  const file = ledgerPath(dataDir);
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, activities: {} };
    throw e;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new LedgerCorruptError(`活动台账解析不了：${file}（${e instanceof Error ? e.message : String(e)}）。修好或挪走这个文件再试；不会当成没有活动`); }
  const acts = (parsed as Ledger | null)?.activities;
  if (!acts || typeof acts !== "object" || Array.isArray(acts)) throw new LedgerCorruptError(`活动台账格式不对（缺 activities 对象）：${file}`);
  for (const [key, rec] of Object.entries(acts)) {
    const problem = recordShapeProblem(rec);
    if (problem) throw new LedgerCorruptError(`活动台账里的「${key}」格式不对（${problem}）：${file}。修好这条再试；不会当成没有活动`);
  }
  return { version: 1, activities: acts };
}

const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(task, task);
  queues.set(key, next);
  const cleanup = () => { if (queues.get(key) === next) queues.delete(key); };
  next.then(cleanup, cleanup);
  return next;
}

/** 在队列里：重读最新台账 → mutate → 原子写回。并发的两次写各改各的 key，互不覆盖 */
export function mutateLedger<T>(dataDir: string | undefined, mutate: (l: Ledger) => T, shouldWrite: (out: T) => boolean = () => true): Promise<T> {
  const file = ledgerPath(dataDir);
  return enqueue(file, async () => {
    assertManagedPathAvailable(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    return withFileLock(file, async () => {
      const ledger = await readLedger(dataDir);
      const out = mutate(ledger);
      if (shouldWrite(out)) await writeJsonAtomicMkdir(file, ledger);
      return out;
    });
  });
}

export type ListedActivity = ActivityRecord & { freshness: Freshness; opens_at?: string };
const ORDER: Record<Freshness, number> = { fresh: 0, recheck: 1, not_open: 2, expired: 3 };

/** activities 动作：fits_us 按 fresh → recheck → expired，not_for_us 全部垫底（带 reason） */
export async function listActivities(dataDir: string | undefined, now: number, platform?: string) {
  const ledger = await readLedger(dataDir);
  const rows = Object.values(ledger.activities)
    .filter((r) => !platform || r.platform === platform)
    .map((r) => { const f = freshnessOf(r, now); return { ...r, freshness: f, ...(f === "not_open" ? { opens_at: r.window?.start } : {}) } as ListedActivity; });
  rows.sort((a, b) => (a.relevance === "not_for_us" ? 1 : 0) - (b.relevance === "not_for_us" ? 1 : 0) || ORDER[a.freshness] - ORDER[b.freshness]);
  const count = (f: Freshness) => rows.filter((r) => r.relevance !== "not_for_us" && r.freshness === f).length;
  return {
    ledger_path: ledgerPath(dataDir),
    activities: rows,
    counts: { fresh: count("fresh"), recheck: count("recheck"), not_open: count("not_open"), expired: count("expired"), not_for_us: rows.filter((r) => r.relevance === "not_for_us").length },
    ...(rows.length ? {} : { note: "台账里还没有这个范围的活动：按完整核查走一遍，核完每条都用 activity_record 入账（适合或不适合都记）" }),
  };
}

/** 疑似重复：同平台、规范化名称互相包含、但 key 不同。只提示，不自动合并（边界 8） */
function possibleDuplicates(l: Ledger, rec: ActivityRecord): string[] {
  const n = normalizeName(rec.name);
  return Object.values(l.activities)
    .filter((r) => r.key !== rec.key && r.platform === rec.platform)
    .filter((r) => { const m = normalizeName(r.name); return !!m && !!n && (m.includes(n) || n.includes(m)); })
    .map((r) => r.key);
}

export type RecordOutcome =
  | { ok: true; created: boolean; record: ActivityRecord; changes: Array<{ field: string; before: unknown; after: unknown }>; possible_duplicates: string[] }
  | { ok: false; code: string; error: string };

function applyRecord(l: Ledger, patch: RecordPatch, at: string): RecordOutcome {
  const k = patchKey(patch);
  if (!k.ok) return { ok: false, code: "bad_param", error: k.error };
  const prev = l.activities[k.value];
  const founder_quote = patch.founder_quote;
  const merged = mergeRecord(prev, k.value, patch);
  if (!merged.ok) return { ok: false, code: "bad_param", error: merged.error };
  const next = merged.value;
  // not_for_us 改成别的（无论怎么改出来的）只认创始人原话（边界 10）
  if (prev?.relevance === "not_for_us" && next.relevance !== "not_for_us" && !founder_quote) {
    return { ok: false, code: "founder_quote_required", error: `「${prev.name}」在台账里是 not_for_us（${prev.reason ?? "无理由"}）；改回 fits_us 要带创始人原话 founder_quote` };
  }
  const changes = prev ? ruleDiff(prev, next) : [];
  if (prev?.evidence?.length && patch.fields.evidence === null) changes.push({ field: "evidence", before: prev.evidence, after: null });
  const entries: HistoryEntry[] = changes.map((c) => ({ at, ...c, ...(c.field === "relevance" && founder_quote ? { founder_quote } : {}) }));
  next.history = [...(prev?.history ?? []), ...entries];
  l.activities[k.value] = next;
  return { ok: true, created: !prev, record: next, changes, possible_duplicates: possibleDuplicates(l, next) };
}

/** 读写都在队列里；bad_param 类拒绝不落盘 */
export function recordActivity(dataDir: string | undefined, patch: RecordPatch, at: string): Promise<RecordOutcome> {
  return mutateLedger(dataDir, (l) => applyRecord(l, patch, at), (r) => r.ok);
}

/**
 * 已定时、还没公开、发布计划里选中了这个台账 key 的其他视频（边界 4：只报数，不回头改）。
 * 扫 <dataDir>/projects/*\/06-publish/publish-plan.json；平台条目与活动用发布把关同一套 parsePlan 读；读不了的计划计入 unreadable，不吞。
 */
export async function scheduledUsers(dataDir: string | undefined, key: string, now: number, excludeContentId?: string) {
  const root = path.join(getDataDir(dataDir), "projects");
  let dirs: string[];
  try { dirs = await fs.readdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { count: 0, unreadable: [] as string[] }; throw e; }
  let count = 0; const unreadable: string[] = [];
  for (const d of dirs) {
    const file = path.join(root, d, "06-publish", "publish-plan.json");
    let plan: Record<string, unknown>;
    try { plan = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR") unreadable.push(file); continue; }
    if (!plan || typeof plan !== "object") { unreadable.push(file); continue; }
    if (excludeContentId && plan.content_id === excludeContentId) continue;
    if (planUsesKey(plan, key, now)) count++;
  }
  return { count, unreadable };
}

type Obj = Record<string, unknown>;
const PUBLIC = new Set(["published", "public", "live", "removed", "rejected", "cancelled"]);

/** 平台还没公开且有定时：publication.status 是公开/终止就不算；定时取 publication.scheduled_at → 条目 → 计划顶层 */
function pendingScheduled(raw: Obj | undefined, entryAt: string | null, plan: Obj, now: number): boolean {
  const pub = raw && typeof raw.publication === "object" && raw.publication ? (raw.publication as Obj) : {};
  if (PUBLIC.has(String(pub.status ?? "")) || pub.published_at || pub.public_url) return false;
  const at = Date.parse(String(pub.scheduled_at ?? entryAt ?? plan.scheduled_at ?? ""));
  return pub.status === "scheduled" || (!Number.isNaN(at) && at > now);
}

function planUsesKey(plan: Obj, key: string, now: number): boolean {
  const rawList = Array.isArray(plan.platforms) ? (plan.platforms as Obj[]) : [];
  return parsePlan(plan).entries.some((e) => {
    const raw = rawList.find((r) => r && typeof r === "object" && normalizePlatform(r.platform) === e.platform);
    if (!pendingScheduled(raw, e.scheduled_at, plan, now)) return false;
    return e.campaigns.some((c) => !!c && typeof c === "object" && (c as Obj).selected === true && ((c as Obj).ledger_key === key || (c as Obj).key === key));
  });
}
