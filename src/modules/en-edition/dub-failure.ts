/**
 * 最近一次配音失败（verifier P3）：失败原因和时间落盘，status 一直显示「配音失败：…」，直到下一次配音成功才清掉——
 * 不让一次失败在下一轮对话里消失成「还没配音」。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { dubDir } from "./dub.js";

export interface DubFailure { reason: string; code: string; at: string; scriptHash: string }

const fileOf = (id: string, dataDir: string) => path.join(dubDir(id, dataDir), "last-failure.json");

/** null = 清掉（配音成功） */
export async function recordDubFailure(id: string, dataDir: string, f: DubFailure | null): Promise<void> {
  if (!f) { await fs.rm(fileOf(id, dataDir), { force: true }); return; }
  await fs.mkdir(path.dirname(fileOf(id, dataDir)), { recursive: true });
  await writeJsonAtomic(fileOf(id, dataDir), f);
}

export async function readDubFailure(id: string, dataDir: string): Promise<DubFailure | null> {
  try { return JSON.parse(await fs.readFile(fileOf(id, dataDir), "utf8")) as DubFailure; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { reason: `上次配音的失败记录读不出来（${(e as Error).message}）`, code: "unreadable", at: "", scriptHash: "" };
  }
}
