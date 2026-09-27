import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLibraryLocation, assertLibraryAvailable } from "./storage-roots.js";

export const WRITER_LOCK = ".autocrew-writer";
const held = new Map<string, string>();
/** A disconnected/replaced writer never regains authority merely because the NAS is back. */
export function assertLibraryWriter(root: string): void {
  const nonce = held.get(path.resolve(root));
  let owner: { nonce?: string; host?: string; pid?: number };
  try { owner = JSON.parse(readFileSync(path.join(root, WRITER_LOCK, "owner.json"), "utf8")); }
  catch { throw new Error("library_writer_lost: 无有效资料库写入占用；请停止写入并检查原服务。"); }
  if (!nonce || owner.nonce !== nonce || owner.host !== os.hostname() || owner.pid !== process.pid) {
    throw new Error("library_writer_lost: 当前服务已失去资料库写入权；不会自动抢占。");
  }
}
/** mkdir is the cross-host exclusion primitive; never steal another host's lock. */
export function acquireLibraryLock(root?: string): () => void {
  const location = readLibraryLocation();
  if (!root && !location) return () => {};
  if (!root) assertLibraryAvailable(location);
  const dir = path.join(root ?? location!.root, WRITER_LOCK);
  const owner = { host: os.hostname(), pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString() };
  try { mkdirSync(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let old: typeof owner;
    try { old = JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8")); }
    catch { throw new Error("资料库正在被占用或占用记录不完整；请确认原服务已停止。"); }
    throw new Error(`资料库已被 ${old.host} 的 AutoCrew 占用；若原进程异常退出，请先确认没有其他写入方，再清理占用记录。`);
  }
  writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
  held.set(path.resolve(root ?? location!.root), owner.nonce);
  return () => {
    const key = path.resolve(root ?? location!.root);
    if (held.get(key) === owner.nonce) held.delete(key);
    try {
      const current = JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8"));
      if (current.nonce === owner.nonce) {
        // Release the entire canonical lock in one rename. Deleting owner.json
        // first can leave an empty busy lock on SMB when shutdown is interrupted.
        const retired = `${dir}-released-${owner.nonce}`;
        renameSync(dir, retired);
        rmSync(retired, { recursive: true });
      }
    } catch { /* An unavailable NAS must never cause a replacement lock to be removed. */ }
  };
}
