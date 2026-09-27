/** Immutable ordinary files, including on SMB volumes without hard links. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertManagedPathAvailable } from "./storage-roots.js";

async function assertAbsent(file: string): Promise<void> {
  try { await fs.lstat(file); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  throw Object.assign(new Error(`文件已存在，不可覆盖：${file}`), { code: "EEXIST", path: file });
}

/**
 * Every publisher takes the same mkdir lock before testing existence and renaming.
 * mkdir arbitrates across processes/hosts; rename exposes only complete bytes.
 * Do not replace this with access+rename without the lock, or copy directly to file.
 * A crash may leave the lock: fail visibly, never steal by age (a NAS writer may
 * still be alive). Only remove a stranded lock after confirming its writer stopped.
 */
export async function writeTextOnce(file: string, content: string): Promise<void> {
  assertManagedPathAvailable(file);
  await assertAbsent(file);
  const lock = `${file}.publish-lock`;
  try { await fs.mkdir(lock); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    await assertAbsent(file);
    throw Object.assign(new Error(`版本正在写入或留有中断记录：${lock}。请先确认原写入进程已停止，再检查该记录；不会抢占或覆盖。`), { code: "EWRITELOCKED", path: lock });
  }
  try {
    await assertAbsent(file);
    await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ host: os.hostname(), pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
    const tmp = path.join(lock, "payload.tmp");
    await fs.writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
    assertManagedPathAvailable(file);
    await assertAbsent(file);
    await fs.rename(tmp, file);
  } finally {
    // Only the process that created this directory may release it. Failure to
    // clean up after a successful rename must not turn a committed version into
    // a reported failed write. An existing destination still always wins.
    await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

export function writeJsonOnce(file: string, value: unknown): Promise<void> {
  return writeTextOnce(file, JSON.stringify(value, null, 2));
}
