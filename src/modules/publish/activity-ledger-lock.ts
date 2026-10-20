/**
 * 活动台账的跨进程锁：Claude 和 Codex 的 MCP 服务是两个进程，进程内队列管不到彼此。
 * <file>.lock 用独占创建（wx）拿锁，里面记 pid + 时间；拿不到就退避重试。
 * 持有者进程已不在（同一台机器）或锁超过 staleMs，视为陈旧锁接管。等到 timeoutMs 还拿不到就报错，绝不无锁写。
 */
import fs from "node:fs/promises";
import os from "node:os";

export const LOCK_TIMING = { timeoutMs: 10_000, staleMs: 30_000, baseDelayMs: 15 };
interface Holder { pid: number; host: string; at: number }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function isStale(lock: string, now: number): Promise<boolean> {
  let h: Holder;
  try { h = JSON.parse(await fs.readFile(lock, "utf8")) as Holder; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    // 写了一半的锁文件：按文件时间判断陈旧
    const st = await fs.stat(lock).catch(() => null);
    return !!st && now - st.mtimeMs > LOCK_TIMING.staleMs;
  }
  if (now - h.at > LOCK_TIMING.staleMs) return true;
  return h.host === os.hostname() && h.pid !== process.pid && !alive(h.pid);
}

async function tryAcquire(lock: string): Promise<boolean> {
  try {
    const fh = await fs.open(lock, "wx");
    try { await fh.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() } satisfies Holder)); }
    finally { await fh.close(); }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMING.timeoutMs;
  let delay = LOCK_TIMING.baseDelayMs;
  while (!(await tryAcquire(lock))) {
    if (await isStale(lock, Date.now())) { await fs.rm(lock, { force: true }); continue; }
    if (Date.now() > deadline) throw new Error(`活动台账被另一个进程占着写（锁文件 ${lock}），等了 ${LOCK_TIMING.timeoutMs / 1000} 秒还没放；这次没有写入。稍后重试，或确认没有别的写入方后删掉锁文件`);
    await new Promise((r) => setTimeout(r, delay + Math.random() * delay));
    delay = Math.min(delay * 2, 200);
  }
  try { return await task(); }
  finally { await fs.rm(lock, { force: true }); }
}
