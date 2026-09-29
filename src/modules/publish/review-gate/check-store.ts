/**
 * 检查留档与 Jev 缓存（spec §2、§2.1、E11）：
 * - 留档 `06-publish/checks/<check_id>.json`：输入、指纹组成、全部问题与答案、模型版本、token、耗时、检查时间；不含密钥。
 * - Jev 结果按检查指纹缓存在 `06-publish/checks/jev-cache/<指纹>.json`；没跑成的不缓存，下次调用重试；
 *   同指纹并发调用合并为一次（进程内），不重复计费。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot, isMissing, safeProjectPath } from "../../../storage/content-project.js";
import { writeJsonAtomicMkdir } from "../../../storage/json-atomic.js";
import type { JevAnswer } from "./jev-client.js";

export interface CachedCall { kind: "A" | "B"; model: string; usage: { input_tokens: number; output_tokens: number }; ms: number; answers: Record<string, JevAnswer> }
export interface JevCacheEntry { fingerprint: string; at: string; calls: CachedCall[] }

const CHECKS_DIR = "06-publish/checks";

export function checksDir(contentId: string, dataDir?: string): string {
  return safeProjectPath(contentRoot(contentId, dataDir), CHECKS_DIR);
}

export function newCheckId(platform: string, fp: string): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `chk-${stamp}-${platform}-${fp.slice(0, 8)}-${crypto.randomBytes(2).toString("hex")}`;
}

export async function writeCheckRecord(contentId: string, checkId: string, record: unknown, dataDir?: string): Promise<string> {
  const file = path.join(checksDir(contentId, dataDir), `${checkId}.json`);
  await writeJsonAtomicMkdir(file, record);
  return file;
}

export async function readCheckRecord(contentId: string, checkId: string, dataDir?: string): Promise<Record<string, unknown> | null> {
  if (!/^chk-[\w-]+$/.test(checkId)) return null;
  try { return JSON.parse(await fs.readFile(path.join(checksDir(contentId, dataDir), `${checkId}.json`), "utf8")) as Record<string, unknown>; } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

const cacheFile = (contentId: string, fp: string, dataDir?: string) => path.join(checksDir(contentId, dataDir), "jev-cache", `${fp}.json`);

export async function readJevCache(contentId: string, fp: string, dataDir?: string): Promise<JevCacheEntry | null> {
  try {
    const raw = JSON.parse(await fs.readFile(cacheFile(contentId, fp, dataDir), "utf8")) as JevCacheEntry;
    return raw.fingerprint === fp && Array.isArray(raw.calls) ? raw : null;
  } catch { return null; }
}

export async function writeJevCache(contentId: string, entry: JevCacheEntry, dataDir?: string): Promise<void> {
  await writeJsonAtomicMkdir(cacheFile(contentId, entry.fingerprint, dataDir), entry);
}

const inflight = new Map<string, Promise<unknown>>();

/** 同一指纹的并发调用合并成一次 */
export function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key);
  if (hit) return hit as Promise<T>;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
