/**
 * Codex 认稿自接（P6 §12.4 B–D）的服务端持久记录：回执、确认记录、原片锁、交接请求、移动日志。
 *
 * 全部落在 `<dataDir>/video/pull/` 下，是服务自己的账，不进项目文件夹（令牌不写进共享文件）。
 * 服务重启后回执和确认记录都还在（§12.6「服务重启」）。
 *
 * 全局交接锁（§12.4-D）：所有交接 / 撤回先排这把锁，再排按稿件的交接线锁——固定「全局 → 稿件」
 * 的顺序，不会反向，所以不会死锁。原片锁的「查 + 占」在这把锁里完成，两条稿抢同一段原片只有一个赢。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "../../../storage/json-atomic.js";

export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export function pullDir(dataDir: string, ...segments: string[]): string {
  return path.join(dataDir, "video", "pull", ...segments);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export async function readRecord<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeRecord(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, value);
}

/** 请求号只当文件名的一部分用：先验字符集，挡住路径穿越 */
export function requestFile(dataDir: string, kind: string, requestId: string): string {
  if (!REQUEST_ID_RE.test(requestId)) throw new Error("request_id 只能是 1–100 位字母、数字、-、_");
  return pullDir(dataDir, kind, `${requestId}.json`);
}

// ---------------------------------------------------------------------------
// 原片锁
// ---------------------------------------------------------------------------

export interface ArollLock {
  content_id: string;
  generation: number;
  request_id?: string;
  at: string;
}

type LockTable = Record<string, ArollLock>;

function lockFile(dataDir: string): string {
  return pullDir(dataDir, "aroll-locks.json");
}

export async function readArollLocks(dataDir: string): Promise<LockTable> {
  return (await readRecord<LockTable>(lockFile(dataDir))) ?? {};
}

export async function arollLockOf(dataDir: string, sha256: string): Promise<ArollLock | null> {
  return (await readArollLocks(dataDir))[sha256] ?? null;
}

/** 只在全局交接锁里调用：查 + 占是一步 */
export async function putArollLock(dataDir: string, sha256: string, lock: ArollLock): Promise<void> {
  const table = await readArollLocks(dataDir);
  await writeRecord(lockFile(dataDir), { ...table, [sha256]: lock });
}

export async function releaseArollLock(dataDir: string, sha256: string, contentId: string): Promise<void> {
  const table = await readArollLocks(dataDir);
  if (table[sha256]?.content_id !== contentId) return;
  const rest = { ...table };
  delete rest[sha256];
  await writeRecord(lockFile(dataDir), rest);
}

// ---------------------------------------------------------------------------
// 撤回纪元：任何交接被撤回后，之前签发的回执一律作废（§12.4-B）
// ---------------------------------------------------------------------------

export async function lastRevokeAt(dataDir: string): Promise<string | null> {
  return (await readRecord<{ at: string }>(pullDir(dataDir, "revoke-epoch.json")))?.at ?? null;
}

export async function bumpRevokeEpoch(dataDir: string, at: string): Promise<void> {
  await writeRecord(pullDir(dataDir, "revoke-epoch.json"), { at });
}

// ---------------------------------------------------------------------------
// 全局交接锁（进程内；守护进程是唯一写者）
// ---------------------------------------------------------------------------

let globalChain: Promise<unknown> = Promise.resolve();

export function withGlobalHandoffLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = globalChain.catch(() => undefined).then(fn);
  globalChain = run.catch(() => undefined);
  return run;
}
