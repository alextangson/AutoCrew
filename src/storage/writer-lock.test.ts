import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireWriterLock, releaseWriterLock, WRITER_LOCK_FILE } from "./writer-lock.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-writer-lock-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("single-writer check (spec §3 D)", () => {
  it("a second live process on the same library is reported; a dead holder is taken over; release only removes our own lock", async () => {
    expect(await acquireWriterLock(dir, process.pid)).toEqual({ ok: true });
    // 另一个活着的进程（父进程一定活着）占着
    await fs.writeFile(path.join(dir, WRITER_LOCK_FILE), JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: "x" }));
    expect(await acquireWriterLock(dir, process.pid)).toMatchObject({ ok: false, holder: { pid: process.ppid } });
    releaseWriterLock(dir, process.pid);
    await expect(fs.access(path.join(dir, WRITER_LOCK_FILE))).resolves.toBeUndefined();
    // 持有者已不在 → 陈旧锁接管
    await fs.writeFile(path.join(dir, WRITER_LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), startedAt: "x" }));
    expect(await acquireWriterLock(dir, process.pid)).toEqual({ ok: true, took_over_stale: true });
    releaseWriterLock(dir, process.pid);
    await expect(fs.access(path.join(dir, WRITER_LOCK_FILE))).rejects.toThrow();
  });
});
