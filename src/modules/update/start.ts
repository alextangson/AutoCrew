/**
 * 「点更新」与 `autocrew update` 共用的入口：现查一次 → 预检 → 拿锁。
 * 服务里拿锁后拉起独立的更新进程（服务自己会被重启）；命令行直接在前台跑同一个 runUpdate。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { checkForUpdate, localVersion } from "./check.js";
import { acquireLock, preflight, releaseLock, RUNNING_MESSAGE, lockHeld, lockAdoptedBy, type PreflightDeps } from "./preflight.js";
import { gitRunner } from "./git.js";
import { newLogFile } from "./updater.js";
import { detectInterrupted } from "./interrupted.js";
import { readResult, writeResult } from "./state.js";
import type { ReleaseNotes } from "./changelog.js";

export const DIVERGED_MESSAGE = (latest: string) =>
  `本地程序和最新发布版 ${latest} 分叉了（本地有发布版里没有的提交），没法自动更新；请按 README 手动更新`;

export interface Prepared { ok: true; tag: string; commit: string; head: string; from: string; to: string; notes: ReleaseNotes[]; token: string }
export type PrepareResult = Prepared | { ok: false; code: string; reason: string };

export async function prepareUpdate(root: string, machineDir: string, deps: Omit<PreflightDeps, "git"> & { git?: PreflightDeps["git"] }): Promise<PrepareResult> {
  if (lockHeld(machineDir)) return { ok: false, code: "running", reason: RUNNING_MESSAGE };
  // 上次更新被硬生生打断：先恢复，不叠着再更新（否则会说「已经是最新版」，把半新半旧盖过去）
  const interrupted = detectInterrupted(root, machineDir, { trustInstall: true });
  if (interrupted) return { ok: false, code: "interrupted", reason: `${interrupted.message}\n${(interrupted.manualCommands ?? []).join("\n")}` };
  const git = deps.git ?? gitRunner(root);
  const status = await checkForUpdate(root, machineDir, { git });
  if (status.error) return { ok: false, code: "check_failed", reason: status.error };
  if (!status.available || !status.tag || !status.latest || !status.commit) {
    // 分叉不是「没什么可更新」，是「更新不了」：命令行要以非 0 退出（e2e P2-1）
    if (status.reason === "diverged") return { ok: false, code: "diverged", reason: DIVERGED_MESSAGE(status.latest ?? "") };
    return { ok: false, code: "no_update", reason: status.reason === "local_ahead" ? "本地程序比最新发布版还新，不用更新" : `已经是最新版 ${status.current}` };
  }
  const pre = await preflight(root, machineDir, status.commit, { ...deps, git });
  if (!pre.ok) return pre;
  // 记下预检时的 HEAD：更新进程动手前再核一次
  const headR = await git(["rev-parse", "HEAD"]);
  if (!headR.ok) return { ok: false, code: "git_failed", reason: "读不出当前版本，没动手" };
  const head = headR.stdout.trim();
  const token = randomBytes(16).toString("hex");
  if (!acquireLock(machineDir, token)) return { ok: false, code: "running", reason: RUNNING_MESSAGE };
  return { ok: true, tag: status.tag, commit: status.commit, head, from: localVersion(root), to: status.latest, notes: status.notes ?? [], token };
}

/**
 * 等更新进程按暗号接手锁。接手之后就不再管它：它自己写的结果文件才是准话，绝不再结束它（Codex 审第 4 轮 P1）。
 */
function waitAdopted(machineDir: string, child: ChildProcess, nonce: string, timeoutMs: number): Promise<true | "timeout" | string> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: true | "timeout" | string) => { if (done) return; done = true; clearInterval(poll); clearTimeout(timer); child.off("exit", onExit); resolve(v); };
    const since = Date.now();
    const adopted = () => lockAdoptedBy(machineDir) === nonce;
    // 接手后很快跑完（比如第一步就失败并退回、锁已放掉）也算接手过：它自己写了结果，不能拿「没能开始」盖掉
    const wroteResult = () => { const r = readResult(machineDir); return Boolean(r && Date.parse(r.at) >= since - 1_000); };
    const onExit = (code: number | null, signal: string | null) =>
      finish(adopted() || wroteResult() ? true : signal ? `信号 ${signal}` : `退出码 ${code}`);
    child.on("exit", onExit);
    const poll = setInterval(() => { if (adopted()) finish(true); }, 50);
    const timer = setTimeout(() => finish(adopted() || wroteResult() ? true : "timeout"), timeoutMs);
  });
}

/**
 * 服务端：拉起脱离服务进程组的更新进程，把锁交给它。等到 spawn / error 再回答：
 * tsx 缺失或不能执行只会在 error 事件里冒出来，不等就会对页面谎报「开始了」（Codex 审 P2）。
 * 起不来：放锁，并写一份「更新没能开始」的结果给页面。
 */
export async function spawnDetachedUpdater(root: string, machineDir: string, port: number, job: Prepared,
  spawnImpl: typeof spawn = spawn, adoptTimeoutMs = 20_000): Promise<{ ok: true; log: string } | { ok: false; reason: string }> {
  const log = newLogFile(machineDir);
  const fail = (e: unknown) => {
    releaseLock(machineDir, job.token);
    const reason = `更新没能开始：${e instanceof Error ? e.message : String(e)}`;
    try { fs.appendFileSync(log, `${reason}\n`); } catch { /* 日志写不了也要把结果交给页面 */ }
    writeResult(machineDir, { ok: false, outcome: "not_started", from: job.from, to: job.to, at: new Date().toISOString(), message: reason, log });
    return { ok: false as const, reason };
  };
  const nonce = randomBytes(16).toString("hex");
  let fd: number | null = null;
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fd = fs.openSync(log, "a", 0o600);
    // 一个 node 进程、--import tsx：没有 tsx 命令行外壳在中间（外壳收到信号几十毫秒就强杀子进程，e2e 1002 P1-A）
    const child = spawnImpl(process.execPath, ["--import", "tsx", path.join(root, "scripts", "update.mts"), "--from-server",
      "--tag", job.tag, "--commit", job.commit, "--head", job.head, "--lock-token", job.token, "--adopt-nonce", nonce, "--log", log, "--port", String(port)], {
      cwd: root, detached: true, stdio: ["ignore", fd, fd],
      env: { ...process.env, AUTOCREW_LOCAL_DIR: machineDir, AUTOCREW_PORT: String(port) },
    });
    const started = await new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (e) => resolve(e));
    });
    if (started) return fail(started);
    // 起来了不等于接手了：脚本可能在 adoptLock 之前就因为依赖缺失退出（Codex 审第 2 轮 P2）。
    // 等它按暗号接手；它先退出或超时 → 放锁、写「没能开始」。超时的那个先放锁（它再接手会失败）再结束掉——
    // 只有确认没接手才结束它，接手了的更新进程绝不碰
    const adopted = await waitAdopted(machineDir, child, nonce, adoptTimeoutMs);
    if (adopted !== true) {
      if (adopted === "timeout") {
        if (lockAdoptedBy(machineDir) === nonce) { child.unref(); return { ok: true, log }; }
        releaseLock(machineDir, job.token);
        try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* 已经不在 */ } }
      }
      return fail(new Error(adopted === "timeout" ? `更新进程 ${Math.round(adoptTimeoutMs / 1000)} 秒内没接手` : `更新进程刚起来就退出了（${adopted}），看日志 ${log}`));
    }
    child.unref();
    return { ok: true, log };
  } catch (e) {
    return fail(e);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
