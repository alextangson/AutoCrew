/**
 * 雷达候选池快照与入库收据（P6 §3.2 / codex #15）——宿主会话自己打分时的幂等与限额落点。
 *
 * 池:radar/pools/<pool_id>.json —— 冻结时的候选 + 画像版本 + 规则版本,24h 过期。
 *   宿主拿到的是快照,不是「当前缓存」:打分期间雷达刷新、画像改动都不会让分数对错候选。
 * 收据:radar/receipts/<pool_id>.json —— 一个池只入一次库。
 *   「只入一次」靠收据文件的独占创建(wx)占位:并发两次提交只有一个能占到,另一个等收据落定后
 *   按提交摘要判重放/已消费。不用跨进程锁,也就没有「抢过期锁」这种容易出错的恢复路径;
 *   占位后进程中断,池就作废(intake_interrupted),下一轮换新池——宁可丢一轮,不许超额。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { personaSummary, goalSummary } from "../profile/creator-profile.js";
import type { CreatorProfile } from "../profile/creator-profile.js";
import type { RadarPoolCandidate } from "./radar-intake.js";

/** 打分规则版本:改了四维口径、入库线或结果契约就 +1,冻结的旧池随之作废(stale_pool)。 */
export const RADAR_RULES_VERSION = 1;
export const POOL_TTL_MS = 24 * 3600_000;
/** 池与收据保留 7 天后清理:过期池已不能入库,收据只为重放服务,一周足够 */
const RETAIN_MS = 7 * 24 * 3600_000;
const POOL_ID_RE = /^pool-\d{13}-[a-z0-9]{6}$/;

export interface FrozenRadarPool {
  version: 1;
  pool_id: string;
  created_at: string;
  expires_at: string;
  profile_version: string;
  rules_version: number;
  cache_fetched_at: string | null;
  candidates: RadarPoolCandidate[];
}

export interface RadarReceiptSaved {
  candidate_id: string;
  topic_id: string;
  title: string;
}

export interface RadarReceipt {
  version: 1;
  /** pending = 已占位正在入库;done = 入库完成;failed = 入库中途出错(池作废) */
  status: "pending" | "done" | "failed";
  pool_id: string;
  receipt_id: string;
  submission_digest: string;
  at: string;
  saved?: RadarReceiptSaved[];
  rejected?: string[];
  not_top3?: string[];
  duplicates?: string[];
  unscored?: string[];
  error?: string;
}

function radarDir(dataDir?: string): string {
  return path.join(getDataDir(dataDir), "radar");
}
function poolFile(poolId: string, dataDir?: string): string {
  return path.join(radarDir(dataDir), "pools", `${poolId}.json`);
}
function receiptFile(poolId: string, dataDir?: string): string {
  return path.join(radarDir(dataDir), "receipts", `${poolId}.json`);
}

/** pool_id 来自宿主(系统边界):只认产品自己发的格式,顺带挡住路径穿越。 */
export function isPoolId(value: unknown): value is string {
  return typeof value === "string" && POOL_ID_RE.test(value);
}

export function receiptIdFor(poolId: string, digest: string): string {
  return `rcpt-${crypto.createHash("sha256").update(`${poolId}:${digest}`).digest("hex").slice(0, 16)}`;
}

/** 画像版本:只取打分真正读到的字段(定位/受众/目标/粗筛关键词),改别的不让池作废。 */
export function radarProfileVersion(profile: CreatorProfile | null): string {
  const basis = JSON.stringify({
    industry: profile?.industry?.trim() ?? "",
    audience: personaSummary(profile?.audiencePersona),
    goal: goalSummary(profile?.goal),
    focusKeywords: profile?.focusKeywords ?? [],
  });
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** 池是可再生的快照:文件损坏按「没有这个池」处理,radar_score 会答 stale_pool 让宿主重新取池。 */
export async function loadRadarPool(poolId: string, dataDir?: string): Promise<FrozenRadarPool | null> {
  if (!isPoolId(poolId)) return null;
  try {
    return await readJsonFile<FrozenRadarPool>(poolFile(poolId, dataDir));
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/** 过期时间读不出来也算过期——宁可让宿主重新取池,不拿来历不明的池入库。 */
export function poolExpired(pool: FrozenRadarPool, now = Date.now()): boolean {
  return !(Date.parse(pool.expires_at) > now);
}

async function hasReceipt(poolId: string, dataDir?: string): Promise<boolean> {
  try {
    await fs.access(receiptFile(poolId, dataDir));
    return true;
  } catch {
    return false;
  }
}

async function listPoolIds(dataDir?: string): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(radarDir(dataDir), "pools"));
    return files.map((f) => f.replace(/\.json$/, "")).filter(isPoolId).sort().reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * 只看最新的那个池:没过期、版本一致、没被消费(有收据 = 占过位)才复用。
 * 不往回翻更老的池——老池里的候选可能已被新池消费过,复用它只会制造混乱。
 */
async function findReusablePool(profileVersion: string, dataDir?: string): Promise<FrozenRadarPool | null> {
  const [latest] = await listPoolIds(dataDir);
  if (!latest) return null;
  const pool = await loadRadarPool(latest, dataDir);
  if (!pool || poolExpired(pool)) return null;
  if (pool.profile_version !== profileVersion || pool.rules_version !== RADAR_RULES_VERSION) return null;
  return (await hasReceipt(latest, dataDir)) ? null : pool;
}

/** 清掉超过保留期的池与收据(按 pool_id 里的时间戳),失败不影响本次冻结。 */
async function pruneOld(dataDir?: string): Promise<void> {
  const cutoff = Date.now() - RETAIN_MS;
  for (const id of await listPoolIds(dataDir)) {
    if (Number(id.split("-")[1]) > cutoff) continue;
    await fs.rm(poolFile(id, dataDir), { force: true }).catch(() => undefined);
    await fs.rm(receiptFile(id, dataDir), { force: true }).catch(() => undefined);
  }
}

// 同进程内的冻结串行化:两个会话同时 radar_pool 时,第二个复用第一个刚冻结的池,而不是各冻一个
let freezeChain: Promise<unknown> = Promise.resolve();

/**
 * 冻结候选池。已有未过期、未消费、版本一致的池,且这次没有新候选(全部 id 都在旧池里)→
 * 原样返回旧池(同一 pool_id);否则冻结新池。
 */
export function freezeRadarPool(
  input: { candidates: RadarPoolCandidate[]; profileVersion: string; cacheFetchedAt: string | null },
  dataDir?: string,
): Promise<{ pool: FrozenRadarPool; reused: boolean }> {
  const run = freezeChain.then(() => freezeNow(input, dataDir));
  freezeChain = run.catch(() => undefined);
  return run;
}

async function freezeNow(
  input: { candidates: RadarPoolCandidate[]; profileVersion: string; cacheFetchedAt: string | null },
  dataDir?: string,
): Promise<{ pool: FrozenRadarPool; reused: boolean }> {
  const existing = await findReusablePool(input.profileVersion, dataDir);
  if (existing) {
    const known = new Set(existing.candidates.map((c) => c.candidate_id));
    if (input.candidates.every((c) => known.has(c.candidate_id))) return { pool: existing, reused: true };
  }
  const now = Date.now();
  const pool: FrozenRadarPool = {
    version: 1,
    pool_id: `pool-${now}-${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + POOL_TTL_MS).toISOString(),
    profile_version: input.profileVersion,
    rules_version: RADAR_RULES_VERSION,
    cache_fetched_at: input.cacheFetchedAt,
    candidates: input.candidates,
  };
  await fs.mkdir(path.dirname(poolFile(pool.pool_id, dataDir)), { recursive: true });
  await writeJsonAtomic(poolFile(pool.pool_id, dataDir), pool);
  await pruneOld(dataDir).catch(() => undefined);
  return { pool, reused: false };
}

/**
 * 读收据。占位文件是 wx 创建后再写入的,并发读者可能读到空/半截 JSON——那就是「正在入库」,
 * 按 pending 处理,不当成损坏。
 */
export async function readReceipt(poolId: string, dataDir?: string): Promise<RadarReceipt | null> {
  let raw: string;
  try {
    raw = await fs.readFile(receiptFile(poolId, dataDir), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as RadarReceipt;
  } catch {
    const at = new Date().toISOString();
    return { version: 1, status: "pending", pool_id: poolId, receipt_id: "", submission_digest: "", at };
  }
}

/** 独占占位:只有第一个调用者返回 true,其余一律 false(无论同进程还是跨进程)。 */
export async function claimReceipt(poolId: string, digest: string, dataDir?: string): Promise<boolean> {
  const file = receiptFile(poolId, dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const pending: RadarReceipt = {
    version: 1,
    status: "pending",
    pool_id: poolId,
    receipt_id: receiptIdFor(poolId, digest),
    submission_digest: digest,
    at: new Date().toISOString(),
  };
  try {
    await fs.writeFile(file, JSON.stringify(pending, null, 2), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** 占位者把收据落定(done/failed),原子替换占位文件。 */
export async function settleReceipt(receipt: RadarReceipt, dataDir?: string): Promise<void> {
  await writeJsonAtomic(receiptFile(receipt.pool_id, dataDir), receipt);
}

/** 等别人的占位落定;超时返回最后看到的收据(仍是 pending)。 */
export async function awaitSettledReceipt(
  poolId: string,
  dataDir?: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<RadarReceipt | null> {
  const deadline = Date.now() + (opts?.timeoutMs ?? 10_000);
  for (;;) {
    const receipt = await readReceipt(poolId, dataDir);
    if (!receipt || receipt.status !== "pending" || Date.now() >= deadline) return receipt;
    await new Promise((resolve) => setTimeout(resolve, opts?.intervalMs ?? 50));
  }
}
