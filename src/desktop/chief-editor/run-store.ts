/**
 * 本机 agent 轮次的持久记录（spec §地基 7 / 8）。
 *
 * 启动 agent **之前**就落盘：对话、后端、资料库、轮次、原话；拿到 ACP session 与进程号后立刻补写。
 * 守护进程重启时凭它把残留 running / awaiting_approval 标成 interrupted，并清掉记下的孤儿进程组。
 * 全局一份（v1 全局只跑 1 个 agent），放在 `~/.autocrew/chief-editor/runs.json`，只留最近 50 条。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalBackendId } from "./backends.js";

export type RunStatus = "running" | "awaiting_approval" | "done" | "interrupted" | "failed";

export interface RunRecord {
  turnId: string;
  clientId: string;
  conversationId: string;
  dataDir: string;
  backend: LocalBackendId;
  message: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  acpSessionId?: string;
  pid?: number;
  /** 启动命令全文：清孤儿前核对 pid 没被别的进程复用 */
  command?: string;
  /** 进程组还没清干净：下次启动继续清 */
  cleanupPending?: boolean;
  /** 本轮已入账的卡片（先落这里再推 SSE，刷新/重启后可回放） */
  cards?: Record<string, unknown>[];
  writes?: string[];
}

const MAX_RECORDS = 50;

export function chiefEditorHome(home = os.homedir()): string {
  return path.join(home, ".autocrew", "chief-editor");
}

export class RunStore {
  constructor(private readonly root: string) {}

  private get file(): string {
    return path.join(this.root, "runs.json");
  }

  list(): RunRecord[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      return Array.isArray(parsed) ? (parsed as RunRecord[]) : [];
    } catch {
      return [];
    }
  }

  get(turnId: string): RunRecord | undefined {
    return this.list().find((r) => r.turnId === turnId);
  }

  /** 同步 temp+rename：check-and-write 之间不许有 await，也不能留半个 JSON */
  private write(records: RunRecord[]): void {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records.slice(-MAX_RECORDS), null, 2), "utf-8");
    fs.renameSync(tmp, this.file);
  }

  put(record: RunRecord): void {
    this.write([...this.list().filter((r) => r.turnId !== record.turnId), record]);
  }

  patch(turnId: string, patch: Partial<RunRecord>): RunRecord | undefined {
    const records = this.list();
    const i = records.findIndex((r) => r.turnId === turnId);
    if (i < 0) return undefined;
    records[i] = { ...records[i], ...patch };
    this.write(records);
    return records[i];
  }

  /**
   * 启动恢复：残留 running / awaiting_approval 一律 interrupted（绝不自动重放），
   * 记下的进程组若仍是原命令就整组杀掉。返回被标中断的记录，调用方负责在对话里留痕。
   */
  recoverOnStartup(killGroup: (pid: number, command: string) => boolean = killRecordedGroup): RunRecord[] {
    const records = this.list();
    const leftovers = records.filter((r) => r.status === "running" || r.status === "awaiting_approval");
    const dirty = records.filter((r) => r.cleanupPending || leftovers.includes(r));
    if (dirty.length === 0) return [];
    const now = new Date().toISOString();
    for (const r of dirty) {
      r.cleanupPending = Boolean(r.pid && r.command) && !killGroup(r.pid!, r.command!);
      if (!r.cleanupPending) delete r.cleanupPending;
    }
    for (const r of leftovers) {
      r.status = "interrupted";
      r.endedAt = now;
    }
    this.write(records);
    return leftovers;
  }
}

export interface ProcRow { pid: number; pgid: number; command: string }

function listProcesses(): ProcRow[] {
  try {
    return execFileSync("ps", ["-A", "-o", "pid=,pgid=,command="], { encoding: "utf-8" })
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] }));
  } catch {
    return [];
  }
}

/**
 * 按进程组清孤儿（评审 P2-7）：组长死了、组员（shell、sleep、ffmpeg…）可能还活着，不能只看组长。
 * - 组长还在但命令对不上 → pid 已被复用，这不是我们的组，不动；
 * - 否则 SIGKILL 整组，重查直到组里没人；清不干净返回 false，记录保留待下次启动再清。
 */
export function killRecordedGroup(pid: number, command: string, list: () => ProcRow[] = listProcesses, kill: (pgid: number) => void = (g) => process.kill(-g, "SIGKILL")): boolean {
  const expected = command.split(" ").slice(0, 2);
  for (let attempt = 0; attempt < 3; attempt++) {
    const members = list().filter((p) => p.pgid === pid);
    if (members.length === 0) return true;
    const leader = members.find((p) => p.pid === pid);
    if (leader && !expected.every((part) => leader.command.includes(part))) return true;
    try { kill(pid); } catch { /* 已退出 */ }
  }
  return list().every((p) => p.pgid !== pid);
}
