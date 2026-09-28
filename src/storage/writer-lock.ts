/**
 * 单写者检查（spec 2026-09-28 §3 D）：同一资料目录只允许一个 AutoCrew 进程写。
 * 档案审批、后台蒸馏、系列登记的串行都只在进程内成立；第二个进程同时写同一目录会互相覆盖。
 *
 * 首版只做启动检查并大声告警，不拒绝启动（误判会把创始人挡在门外，代价比告警大）。
 * 锁文件记 pid；持有者进程已不在就视为陈旧锁并接管。
 */
import fs from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const WRITER_LOCK_FILE = ".autocrew-writer.lock";

export interface WriterLockHolder { pid: number; host: string; startedAt: string }
export type WriterLockResult = { ok: true; took_over_stale?: boolean } | { ok: false; holder: WriterLockHolder };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function acquireWriterLock(dataDir: string, pid = process.pid): Promise<WriterLockResult> {
  const file = path.join(dataDir, WRITER_LOCK_FILE);
  let stale = false;
  try {
    const holder = JSON.parse(await fs.readFile(file, "utf8")) as WriterLockHolder;
    if (holder.pid !== pid && holder.host === os.hostname() && alive(holder.pid)) return { ok: false, holder };
    stale = holder.pid !== pid;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid, host: os.hostname(), startedAt: new Date().toISOString() } satisfies WriterLockHolder));
  return stale ? { ok: true, took_over_stale: true } : { ok: true };
}

/** 同步释放：挂在 process "exit" 上，那里不能等异步 IO */
export function releaseWriterLock(dataDir: string, pid = process.pid): void {
  const file = path.join(dataDir, WRITER_LOCK_FILE);
  try {
    const holder = JSON.parse(readFileSync(file, "utf8")) as WriterLockHolder;
    if (holder.pid === pid) unlinkSync(file);
  } catch { /* 没有锁或已被接管：什么都不做 */ }
}
