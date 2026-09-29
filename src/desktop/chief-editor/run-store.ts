/**
 * 本机 agent 轮次的持久记录（spec §地基 7 / 8）。
 *
 * 启动 agent **之前**就落盘：对话、后端、资料库、轮次、原话；拿到 ACP session 与进程号后立刻补写。
 * 守护进程重启时凭它把残留 running / awaiting_approval 标成 interrupted，并清掉记下的孤儿进程组。
 * 全局一份（v1 全局只跑 1 个 agent），放在 `~/.autocrew/chief-editor/runs.json`，只留最近 50 条。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { getMachineDir } from "../../storage/storage-roots.js";
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
  /** 记录这一轮的服务进程：启动恢复只碰「主人已经不在」的轮，绝不碰别的活着的服务的轮 */
  owner?: ProcessIdentity;
  /** 这一轮是冲着哪篇稿去的（重试接回原对话时，认领里的 session 对不上就按它找） */
  contentId?: string;
  /** 过程块（工作记录）：重启恢复时重建「已停止」块 */
  worklog?: Array<Record<string, unknown>>;
}

const MAX_RECORDS = 50;

/**
 * 总编辑的状态目录跟着**本服务的**状态目录走（AUTOCREW_LOCAL_DIR / AUTOCREW_DATA_DIR，缺省 ~/.autocrew）：
 * 以前写死 ~/.autocrew/chief-editor，同一台机器上的每个服务（:4317、预览服务、测试守护进程）共用一份 runs.json，
 * 新起的服务把别的服务**正在跑**的轮标成中断、还杀它的进程组（2026-09-29 事故）。
 * 缺省服务的路径不变（~/.autocrew/chief-editor），已有的记录、人设、上报清单一个都不丢。
 */
export function chiefEditorHome(machineDir = getMachineDir()): string {
  return path.join(machineDir, "chief-editor");
}

/** 进程身份：pid + 启动时刻（ps lstart）——pid 会被复用，两样都对上才算同一个进程 */
export interface ProcessIdentity { pid: number; lstart: string }

export function processIdentity(pid = process.pid): ProcessIdentity {
  return { pid, lstart: psField(pid, "lstart") };
}

function psField(pid: number, field: string): string {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/** 记录这一轮的那个服务还活着吗：pid 在、且启动时刻对得上 */
export function ownerAlive(owner: ProcessIdentity, lookup: (pid: number) => string = (p) => psField(p, "lstart")): boolean {
  const now = lookup(owner.pid);
  return Boolean(now) && now === owner.lstart;
}

export class RunStore {
  constructor(private readonly root: string, private readonly owner: ProcessIdentity = processIdentity()) {}

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
    const owned = record.owner ? record : { ...record, owner: this.owner };
    this.write([...this.list().filter((r) => r.turnId !== record.turnId), owned]);
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
  recoverOnStartup(
    killGroup: (pid: number, command: string) => boolean = killRecordedGroup,
    isOwnerAlive: (owner: ProcessIdentity) => boolean = ownerAlive,
  ): RunRecord[] {
    const records = this.list();
    // 只收拾「主人已经不在」的轮：别的服务（或同一台机器上另一个仍活着的实例）的轮一律不碰
    // 旧记录没有主人信息：只有它的 agent 进程已经不在了才算孤儿（agent 还活着 = 可能是别的服务正在跑的轮，不碰）
    const orphaned = (r: RunRecord) => r.owner
      ? (r.owner.pid !== this.owner.pid || r.owner.lstart !== this.owner.lstart) && !isOwnerAlive(r.owner)
      : !r.pid || !isOwnerAlive({ pid: r.pid, lstart: psField(r.pid, "lstart") || "gone" });
    const leftovers = records.filter((r) => (r.status === "running" || r.status === "awaiting_approval") && orphaned(r));
    const dirty = records.filter((r) => (r.cleanupPending && orphaned(r)) || leftovers.includes(r));
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
