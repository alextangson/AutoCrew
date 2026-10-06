/** 哈希缓存的并发（fix/hash-cpu Codex P2）：存盘串行、写途中的改动不丢；同一份字节并发读只算一次 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 可卡住的存盘：gate 设了就等它放行再真正写 */
let gate: Promise<void> | null = null;
vi.mock("../../storage/json-atomic.js", async (orig) => {
  const m = await orig<typeof import("../../storage/json-atomic.js")>();
  return { ...m, writeJsonAtomicMkdir: async (file: string, value: unknown) => { const g = gate; if (g) await g; return m.writeJsonAtomicMkdir(file, value); } };
});

const { cachedSha, loadHashCache, resetHashCacheMemory, saveHashCache } = await import("./hash-cache.js");
const { fullHashCount } = await import("../video/handoff/manifest.js");
const { productionServiceDir } = await import("../../storage/production-store.js");

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-hash-cache-")); resetHashCacheMemory(); gate = null; });
afterEach(async () => { resetHashCacheMemory(); await fs.rm(dir, { recursive: true, force: true }); });

const onDisk = async () => JSON.parse(await fs.readFile(productionServiceDir(dir, "hash-cache.json"), "utf8")) as Record<string, unknown>;
const file = async (name: string, bytes: string) => { const f = path.join(dir, name); await fs.writeFile(f, bytes); return f; };

describe("存盘", () => {
  it("慢的旧写不会盖掉新写；写途中算出的条目也落盘", async () => {
    await loadHashCache(dir);
    const a = await file("a.mp4", "aaa"), b = await file("b.mp4", "bbb");
    await cachedSha(a);
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const first = saveHashCache(dir); // 快照只有 a，卡在写之前
    await new Promise((r) => setImmediate(r));
    gate = null;
    await cachedSha(b); // 写途中的改动
    const second = saveHashCache(dir);
    await new Promise((r) => setTimeout(r, 50)); // 让后一次（若不排队）先写完，再放旧快照落盘
    release();
    await Promise.all([first, second]);
    expect(Object.keys(await onDisk()).sort()).toEqual([a, b].sort());
  });
});

describe("并发读", () => {
  it("同一份字节四个并发读只算一次全量哈希", async () => {
    const f = await file("big.mp4", "x".repeat(1 << 20));
    const n = fullHashCount();
    const shas = await Promise.all([cachedSha(f), cachedSha(f), cachedSha(f), cachedSha(f)]);
    expect(new Set(shas.map((s) => s.sha256)).size).toBe(1);
    expect(fullHashCount() - n).toBe(1);
  });
});
