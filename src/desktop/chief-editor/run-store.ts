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
    if (leftovers.length === 0) return [];
    const now = new Date().toISOString();
    for (const r of leftovers) {
      if (r.pid && r.command) killGroup(r.pid, r.command);
      r.status = "interrupted";
      r.endedAt = now;
    }
    this.write(records);
    return leftovers;
  }
}

/** pid 还活着且命令对得上才杀整组——pid 复用时绝不误杀别的进程 */
export function killRecordedGroup(pid: number, command: string): boolean {
  let actual = "";
  try {
    actual = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8" }).trim();
  } catch {
    return false; // 进程已不在
  }
  if (!actual || !command.split(" ").slice(0, 2).every((part) => actual.includes(part))) return false;
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}
