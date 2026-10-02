/**
 * 更新前的预检（self-update §3-8）与防重复的锁（§3-11）。任一不满足就不动手，回一句人话。
 * 「有没有人在跑」复用总编辑的轮次记录（runs.json）与它判断「主人还活着」的同一套逻辑。
 */
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { randomBytes } from "node:crypto";
import { firstLine, type GitRunner } from "./git.js";
import { isGitInstall, NOT_GIT } from "./check.js";
import { files } from "./state.js";
import { getMachineDir } from "../../storage/storage-roots.js";
import { RunStore, chiefEditorHome, ownerAlive, agentStillThere, startEpoch, type RunRecord } from "../../desktop/chief-editor/run-store.js";

export const RUNNING_MESSAGE = "正在更新，等它跑完";
export const UNMANAGED_MESSAGE = "这次 AutoCrew 不是用 npm start 启动的，没法自动重启。先在运行 AutoCrew 的终端里按 Ctrl-C 停掉，再运行 npm start，之后再点更新。";
export const SERVE_MESSAGE = "这次 AutoCrew 是用 npm run serve 启动的，没法自动重启。先在运行 AutoCrew 的终端里按 Ctrl-C 停掉，再运行 npm start，之后再点更新。";
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
  launcher?: () => Promise<{ running: boolean; managed: boolean; via?: "launcher" | "serve" | "other" }>;
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
  // 不报个数：同一件事可能在请求、通道、对话轮几处各算一次，数字会虚高（e2e 1002 P3-G）；去重会漏算后台活，宁可不说数
  return "有任务正在跑（写稿、对话、发布或剪辑），等它们停下再更新";
}

/** target = 要合到的提交（origin 公布的 tag 所指），不是本地 tag 名 */
export async function preflight(root: string, machineDir: string, target: string, deps: PreflightDeps): Promise<Preflight> {
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
  const ancestor = await git(["merge-base", "--is-ancestor", "HEAD", target]);
  if (!ancestor.ok) return no("not_ancestor", "本地程序比要更新到的发布版还新，或者已经分叉，不能自动更新");
  const busy = busyWork(machineDir, deps);
  if (busy) return no("busy", busy);
  if (deps.remoteBusy) {
    let remote: string | null;
    try { remote = await deps.remoteBusy(); }
    catch (e) { return no("busy_unknown", `没法确认 AutoCrew 现在空闲（${e instanceof Error ? e.message : String(e)}），稍后再试或先停掉服务`); }
    if (remote) return no("busy", remote);
  }
  const launcher = deps.launcher ? await deps.launcher() : { running: false, managed: true };
  if (launcher.running && !launcher.managed) return no("unmanaged", launcher.via === "serve" ? SERVE_MESSAGE : UNMANAGED_MESSAGE);
  return { ok: true };
}

/* ── 锁 ───────────────────────────────────────────────────────────── */

interface LockBody { pid: number; token: string; at: string; adopted?: string; /** 持锁进程的启动时刻（UTC 秒）：pid 会被复用，两样都对上才算同一个进程 */ start?: number }

/** 持锁进程还在：pid 在，且（记了启动时刻的话）启动时刻对得上——pid 被别的进程复用不算（e2e P3） */
function ownerLive(body: LockBody, lookup: (pid: number) => number | null = startEpoch): boolean {
  if (!pidAlive(body.pid)) return false;
  return typeof body.start === "number" && body.start > 0 ? ownerAlive({ pid: body.pid, start: body.start }, lookup) : true;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function readLock(machineDir: string): LockBody | null {
  try { return JSON.parse(fs.readFileSync(files(machineDir).lock, "utf-8")) as LockBody; } catch { return null; }
}

/** 读不出内容（空的、半截的）的锁在这段时间内一律当「有人刚拿」，过了才算死锁（Codex 审第 7 轮 P2） */
export const UNREADABLE_LOCK_GRACE_MS = 10_000;

type LockState = { kind: "none" } | { kind: "live"; body: LockBody | null } | { kind: "dead"; token: string | null };

function lockState(machineDir: string, now = Date.now()): LockState {
  const file = files(machineDir).lock;
  let mtime: number;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return { kind: "none" }; }
  const body = readLock(machineDir);
  if (!body) return now - mtime < UNREADABLE_LOCK_GRACE_MS ? { kind: "live", body: null } : { kind: "dead", token: null };
  return ownerLive(body) ? { kind: "live", body } : { kind: "dead", token: body.token };
}

/** 持锁进程的 pid（没有锁就是 null） */
export function lockOwner(machineDir: string): number | null {
  return readLock(machineDir)?.pid ?? null;
}

/** 锁在、且持锁进程还活着（读不出内容的新锁也算） */
export function lockHeld(machineDir: string): boolean {
  return lockState(machineDir).kind === "live";
}

/**
 * 原子发布一份完整的锁：先写进本进程独有的临时文件，再 link 到锁的位置——link 是原子的、目标已存在就失败，
 * 所以锁文件一出现就是完整的 JSON，不会有「空文件被别人当死锁收走」的缝（Codex 审第 7 轮 P2）。
 */
function publishLock(file: string, body: LockBody): boolean {
  const tmp = `${file}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(body));
  try { fs.linkSync(tmp, file); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
  finally { fs.rmSync(tmp, { force: true }); }
}

/**
 * 收回死锁、接手锁这两件改动别人锁文件的事，排在同一把短锁后面串行做（Codex 审第 8 轮 P2）。
 * 短锁用 proper-lockfile：mkdir 建锁、过期（10 秒没刷新）自动作废，是现成的、经过检验的原语，不再自己手写抢锁。
 * 持有时间只有几毫秒；拿不到就短暂重试，仍拿不到说明别人正在收回 / 接手，本次当没拿到。
 */
function withReclaimMutex<T>(machineDir: string, fn: () => T): { ok: true; value: T } | { ok: false } {
  const target = path.join(machineDir, "update.lock.guard");
  fs.writeFileSync(target, "", { flag: "a" });
  let release: (() => void) | null = null;
  const deadline = Date.now() + 2_000;
  while (!release) {
    try { release = lockfile.lockSync(target, { stale: 10_000, realpath: false }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() > deadline) return { ok: false };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return { ok: true, value: fn() }; } finally { release(); }
}

/**
 * 拿锁：没人持有就原子发布一份（link，别人已发布则失败）；已被活进程持有（或刚出现、还读不出内容）就返回 false。
 * 持锁进程死了：在收回短锁里再核对一次「还是那把死锁」，才删掉它、发布自己的——活锁绝不挪开。
 */
export function acquireLock(machineDir: string, token: string, pid = process.pid): boolean {
  const file = files(machineDir).lock;
  fs.mkdirSync(machineDir, { recursive: true });
  const body = (): LockBody => ({ pid, token, at: new Date().toISOString(), start: startEpoch(pid) ?? 0 });
  if (publishLock(file, body())) return true;
  const seen = lockState(machineDir);
  if (seen.kind !== "dead") return seen.kind === "none" ? publishLock(file, body()) : false;
  const r = withReclaimMutex(machineDir, () => {
    const now = lockState(machineDir);
    if (now.kind === "none") return publishLock(file, body());
    if (now.kind !== "dead" || now.token !== seen.token) return false;
    fs.rmSync(file, { force: true });
    return publishLock(file, body());
  });
  return r.ok && r.value;
}

/**
 * 服务拿锁后交给它拉起的更新进程：令牌对上才接，并写下服务给的接手暗号。
 * 服务按暗号确认接手，不比 pid——服务拿到的是 tsx 启动器的 pid，跑脚本的是 tsx 拉起的另一个 node（Codex 审第 4 轮 P1）。
 */
export function adoptLock(machineDir: string, token: string, nonce: string, pid = process.pid): boolean {
  // 和收回死锁排在同一把短锁后面：核对令牌与整体替换之间，别人不会把这把锁收走再换成新的
  const r = withReclaimMutex(machineDir, () => {
    const body = readLock(machineDir);
    if (!body || body.token !== token) return false;
    // 整份写进临时文件再 rename 覆盖（原子替换），不截断重写——别人任何时刻读到的都是完整的锁
    const file = files(machineDir).lock;
    const tmp = `${file}.adopt-${process.pid}-${randomBytes(6).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...body, pid, start: startEpoch(pid) ?? 0, adopted: nonce }));
    try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    return true;
  });
  return r.ok && r.value;
}

/** 锁上写着的接手暗号（还没接手 / 没有锁就是 null） */
export function lockAdoptedBy(machineDir: string): string | null {
  return readLock(machineDir)?.adopted ?? null;
}

export function releaseLock(machineDir: string, token: string): void {
  if (readLock(machineDir)?.token === token) fs.rmSync(files(machineDir).lock, { force: true });
}
