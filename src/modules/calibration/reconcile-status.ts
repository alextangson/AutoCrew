/**
 * 自动对账最近一轮的结果（账本汇总条与晨报读）。内存一份（同进程的 IPC / MCP 立刻可见，
 * 丢写入锁时也只能记在这里）；持有写入锁时再落一份 calibration/reconcile-status.json，重启后还能看到。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { calibrationDir } from "./store.js";

export interface ReconcileStatus {
  at: string;
  ok: boolean;
  /** library_writer_lost / library_unavailable / integrity / error */
  code?: string;
  error?: string;
  written: Array<{ prediction_id: string; kind: "t3" | "d7" }>;
  waiting: string[];
  waiting_d7: string[];
  prompts: string[];
}

const memory = new Map<string, ReconcileStatus>();
const FILE = "reconcile-status.json";

export async function saveReconcileStatus(status: ReconcileStatus, dataDir: string | undefined, persist: boolean): Promise<void> {
  memory.set(calibrationDir(dataDir), status);
  if (persist) await writeJsonAtomic(path.join(calibrationDir(dataDir), FILE), status);
}

export async function readReconcileStatus(dataDir?: string): Promise<ReconcileStatus | null> {
  const mem = memory.get(calibrationDir(dataDir));
  if (mem) return mem;
  try { return JSON.parse(await fs.readFile(path.join(calibrationDir(dataDir), FILE), "utf-8")) as ReconcileStatus; } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    return { at: "", ok: false, code: "error", error: `对账状态文件读不出来：${(err as Error).message}`, written: [], waiting: [], waiting_d7: [], prompts: [] };
  }
}

/** 测试用：清掉内存里的状态 */
export function resetReconcileMemory(): void { memory.clear(); }
