/**
 * 文件指纹的两种算法：
 * - 读 / 看（列表、状态、收件箱、我的内容、产物播放、分镜扫描、影子对账）：`cachedSha`——按（dev, ino, 大小, 修改时间）认同一份字节，
 *   键对上就不重算。多 GB 的成片每分钟全量重算会吃掉一两个核。
 * - 定（创始人决定、登记提交、发布前核对）：`commitSha`——一定现算全文件；最近一分钟内还在变的文件拒绝，不在写到一半时算。
 *
 * 缓存落盘到工作区服务目录的 hash-cache.json（读路径也会存，防抖 + 原子写）；对账每轮清掉文件没了 / 键对不上的条目，总数有上限（LRU）。
 * 它只是缓存：键对不上就重算，坏了当空。
 */
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { productionServiceDir } from "../../storage/production-store.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { sha256File } from "../video/handoff/manifest.js";
import { now } from "./roots.js";

export const SETTLE_MS = 60_000;
export const STILL_SETTLING = "文件还在写，等一分钟再定";
const MAX_ENTRIES = 5000;
const SAVE_DELAY_MS = 2000;

let settleOverride: number | null = null;
/** 测试缝：调「一分钟内改过算还在写」的窗口（测试环境默认经 AUTOCREW_TEST_SETTLE_MS 关掉，见 src/test-setup/hash-settle.ts） */
export function setSettleMs(ms: number | null): void { settleOverride = ms; }
const settleMs = (): number => settleOverride ?? (process.env.VITEST && process.env.AUTOCREW_TEST_SETTLE_MS ? Number(process.env.AUTOCREW_TEST_SETTLE_MS) : SETTLE_MS);

/** 修改时间离现在不到一分钟：扫描这轮跳过，提交点拒绝 */
export const unsettled = (mtimeMs: number): boolean => settleMs() > 0 && now() - mtimeMs < settleMs();

type Entry = { key: string; sha: string };
const cache = new Map<string, Entry>();
const loaded = new Set<string>();
let dirty = false;
let saveDir: string | null = null;
let timer: NodeJS.Timeout | null = null;

const keyOf = (st: Stats) => `${st.dev}:${st.ino}:${st.size}:${Math.trunc(st.mtimeMs)}`;
const cacheFile = (dataDir: string) => productionServiceDir(dataDir, "hash-cache.json");

/** 读进落盘的缓存（每个工作区只读一次，内存里的为准）；之后读路径算出的新条目会防抖存回这里 */
export async function loadHashCache(dataDir: string): Promise<void> {
  saveDir = dataDir;
  if (loaded.has(dataDir)) return;
  loaded.add(dataDir);
  try {
    const raw = JSON.parse(await fs.readFile(cacheFile(dataDir), "utf8")) as Record<string, Entry>;
    for (const [k, v] of Object.entries(raw)) if (!cache.has(k) && typeof v?.key === "string" && /^[a-f0-9]{64}$/.test(v.sha)) cache.set(k, v);
  } catch { /* 没有或坏了：当空缓存，照常重算 */ }
}

export async function saveHashCache(dataDir: string): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty) return;
  dirty = false;
  try { await writeJsonAtomicMkdir(cacheFile(dataDir), Object.fromEntries(cache)); }
  catch (e) { dirty = true; throw e; }
}

function scheduleSave(): void {
  if (timer || !saveDir) return;
  const dir = saveDir;
  timer = setTimeout(() => { timer = null; void saveHashCache(dir).catch(() => undefined); }, SAVE_DELAY_MS);
  timer.unref();
}

function remember(file: string, entry: Entry): void {
  cache.delete(file);
  cache.set(file, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  dirty = true;
  scheduleSave();
}

/** 读路径：元数据对上就用缓存，否则流式现算一次并记下 */
export async function cachedSha(file: string): Promise<{ sha256: string; size: number; mtime_ms: number }> {
  const st = await fs.stat(file);
  const key = keyOf(st);
  const hit = cache.get(file);
  let sha256: string;
  if (hit?.key === key) { sha256 = hit.sha; cache.delete(file); cache.set(file, hit); }
  else { sha256 = await sha256File(file); remember(file, { key, sha: sha256 }); }
  return { sha256, size: st.size, mtime_ms: Math.trunc(st.mtimeMs) };
}

export type CommitSha = { ok: true; sha256: string; size: number; mtime_ms: number; key: string } | { ok: false; reason: string };

/** 提交点：一定现算；一分钟内改过、或算的时候变了 → 拒绝并说「还在写」。文件不在 / 读不了照常抛错 */
export async function commitSha(file: string): Promise<CommitSha> {
  const before = await fs.stat(file);
  if (unsettled(before.mtimeMs)) return { ok: false, reason: STILL_SETTLING };
  const sha256 = await sha256File(file);
  const after = await fs.stat(file);
  if (keyOf(after) !== keyOf(before)) return { ok: false, reason: STILL_SETTLING };
  remember(file, { key: keyOf(after), sha: sha256 });
  return { ok: true, sha256, size: after.size, mtime_ms: Math.trunc(after.mtimeMs), key: keyOf(after) };
}

/** 文件元数据身份（不算哈希）；不在 → "missing" */
export async function metaKey(file: string): Promise<string> {
  return fs.stat(file).then(keyOf, () => "missing");
}

/** 对账每轮：文件没了、或元数据和记下的不一样了的条目清掉 */
export async function sweepHashCache(): Promise<number> {
  let dropped = 0;
  for (const [file, entry] of [...cache]) {
    if ((await metaKey(file)) === entry.key) continue;
    cache.delete(file);
    dropped++;
  }
  if (dropped) { dirty = true; scheduleSave(); }
  return dropped;
}

/** 测试用：清掉内存（模拟重启） */
export function resetHashCacheMemory(): void {
  cache.clear();
  loaded.clear();
  dirty = false;
  saveDir = null;
  if (timer) { clearTimeout(timer); timer = null; }
}

export const hashCacheSize = (): number => cache.size;
