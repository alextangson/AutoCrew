/**
 * 更新前的预检（self-update §3-8）与防重复的锁（§3-11）。任一不满足就不动手，回一句人话。
 * 「有没有人在跑」复用总编辑的轮次记录（runs.json）与它判断「主人还活着」的同一套逻辑。
 */
import fs from "node:fs";
import { firstLine, type GitRunner } from "./git.js";
import { isGitInstall, NOT_GIT } from "./check.js";
import { files } from "./state.js";
import { getMachineDir } from "../../storage/storage-roots.js";
import { RunStore, chiefEditorHome, ownerAlive, agentStillThere, type RunRecord } from "../../desktop/chief-editor/run-store.js";

export const RUNNING_MESSAGE = "正在更新，等它跑完";
export const UPDATING_MESSAGE = "AutoCrew 正在更新，稍后再试";

/** 更新锁在手时，新的对话轮、本机 agent 轮、发布动作一律不开（已经在跑的不碰） */
export function updatingRefusal(machineDir = getMachineDir()): string | null {
  return lockHeld(machineDir) ? UPDATING_MESSAGE : null;
}

export interface PreflightDeps {
  git: GitRunner;
  /** 本进程里的活跃对话轮（服务里传 activeTurnCount；命令行没有就是 0） */
  inProcessTurns?: () => number;
  /** 轮次记录的「还在跑」判断，测试注入 */
  runAlive?: (r: RunRecord) => boolean;
  /** 服务是不是由启动器（npm start）管着：不是就没法自动重启 */
  launcher?: () => Promise<{ running: boolean; managed: boolean }>;
  /** 命令行里问正在跑的服务有没有轮在跑（null = 空闲；抛 = 问不到） */
  remoteBusy?: () => Promise<string | null>;
}

export type Preflight = { ok: true } | { ok: false; code: string; reason: string };

function defaultRunAlive(r: RunRecord): boolean {
  return r.owner ? ownerAlive(r.owner) : agentStillThere(r.pid, r.command);
}

/** 正在跑的写稿 / 剪辑 / 发布轮（总编辑本机 agent 的记录 + 本进程的对话轮） */
export function busyWork(machineDir: string, deps: Pick<PreflightDeps, "inProcessTurns" | "runAlive"> = {}): string | null {
  const alive = deps.runAlive ?? defaultRunAlive;
  const running = new RunStore(chiefEditorHome(machineDir), { pid: process.pid }).list()
    .filter((r) => (r.status === "running" || r.status === "awaiting_approval") && alive(r));
  const turns = deps.inProcessTurns?.() ?? 0;
  if (running.length === 0 && turns === 0) return null;
  return `有 ${running.length + turns} 个任务正在跑（写稿、剪辑或发布），等它们停下再更新`;
}

export async function preflight(root: string, machineDir: string, tag: string, deps: PreflightDeps): Promise<Preflight> {
  const { git } = deps;
  const no = (code: string, reason: string): Preflight => ({ ok: false, code, reason });
  if (lockHeld(machineDir)) return no("running", RUNNING_MESSAGE);
  if (!(await isGitInstall(root, git))) return no("not_git", NOT_GIT);
  const branch = await git(["symbolic-ref", "--short", "-q", "HEAD"]);
  const name = firstLine(branch.stdout);
  if (name !== "main") return no("not_main", `现在不在 main 分支上（${name || "没有分支"}），切回 main 再更新`);
  const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (!dirty.ok) return no("git_failed", `读不出本地改动（${firstLine(dirty.stderr)}）`);
  if (dirty.stdout.trim()) return no("dirty", "程序文件有本地改动，自动更新会覆盖它们；先提交或撤掉这些改动再更新");
  const ancestor = await git(["merge-base", "--is-ancestor", "HEAD", `${tag}^{commit}`]);
  if (!ancestor.ok) return no("not_ancestor", `本地程序比 ${tag} 新或者已经分叉，不能自动更新`);
  const busy = busyWork(machineDir, deps);
  if (busy) return no("busy", busy);
  if (deps.remoteBusy) {
    let remote: string | null;
    try { remote = await deps.remoteBusy(); }
    catch (e) { return no("busy_unknown", `没法确认 AutoCrew 现在空闲（${e instanceof Error ? e.message : String(e)}），稍后再试或先停掉服务`); }
    if (remote) return no("busy", remote);
  }
  const launcher = deps.launcher ? await deps.launcher() : { running: false, managed: true };
  if (launcher.running && !launcher.managed) return no("unmanaged", "AutoCrew 不是用 npm start 启动的，没法自动重启；请按 README 手动更新");
  return { ok: true };
}

/* ── 锁 ───────────────────────────────────────────────────────────── */

interface LockBody { pid: number; token: string; at: string }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function readLock(machineDir: string): LockBody | null {
  try { return JSON.parse(fs.readFileSync(files(machineDir).lock, "utf-8")) as LockBody; } catch { return null; }
}

/** 锁在、且持锁进程还活着 */
export function lockHeld(machineDir: string): boolean {
  const body = readLock(machineDir);
  return Boolean(body && pidAlive(body.pid));
}

/** 拿锁：已被活进程持有就返回 false；持锁进程死了的旧锁清掉重拿 */
export function acquireLock(machineDir: string, token: string, pid = process.pid): boolean {
  const file = files(machineDir).lock;
  fs.mkdirSync(machineDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, token, at: new Date().toISOString() }), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (lockHeld(machineDir)) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

/** 服务拿锁后交给它拉起的更新进程：令牌对上才接 */
export function adoptLock(machineDir: string, token: string, pid = process.pid): boolean {
  const body = readLock(machineDir);
  if (!body || body.token !== token) return false;
  fs.writeFileSync(files(machineDir).lock, JSON.stringify({ ...body, pid }));
  return true;
}

export function releaseLock(machineDir: string, token: string): void {
  if (readLock(machineDir)?.token === token) fs.rmSync(files(machineDir).lock, { force: true });
}
