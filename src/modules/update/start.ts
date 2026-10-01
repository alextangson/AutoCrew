/**
 * 「点更新」与 `autocrew update` 共用的入口：现查一次 → 预检 → 拿锁。
 * 服务里拿锁后拉起独立的更新进程（服务自己会被重启）；命令行直接在前台跑同一个 runUpdate。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { checkForUpdate, localVersion } from "./check.js";
import { acquireLock, preflight, releaseLock, RUNNING_MESSAGE, lockHeld, type PreflightDeps } from "./preflight.js";
import { gitRunner } from "./git.js";
import { newLogFile } from "./updater.js";
import type { ReleaseNotes } from "./changelog.js";

export interface Prepared { ok: true; tag: string; from: string; to: string; notes: ReleaseNotes[]; token: string }
export type PrepareResult = Prepared | { ok: false; code: string; reason: string };

export async function prepareUpdate(root: string, machineDir: string, deps: Omit<PreflightDeps, "git"> & { git?: PreflightDeps["git"] }): Promise<PrepareResult> {
  if (lockHeld(machineDir)) return { ok: false, code: "running", reason: RUNNING_MESSAGE };
  const git = deps.git ?? gitRunner(root);
  const status = await checkForUpdate(root, machineDir, { git });
  if (status.error) return { ok: false, code: "check_failed", reason: status.error };
  if (!status.available || !status.tag || !status.latest) {
    return { ok: false, code: "no_update", reason: status.reason === "local_ahead" ? "本地程序比最新发布版还新，不用更新" : `已经是最新版 ${status.current}` };
  }
  const pre = await preflight(root, machineDir, status.tag, { ...deps, git });
  if (!pre.ok) return pre;
  const token = randomBytes(16).toString("hex");
  if (!acquireLock(machineDir, token)) return { ok: false, code: "running", reason: RUNNING_MESSAGE };
  return { ok: true, tag: status.tag, from: localVersion(root), to: status.latest, notes: status.notes ?? [], token };
}

/** 服务端：拉起脱离服务进程组的更新进程，把锁交给它。起不来就放锁并如实报错。 */
export function spawnDetachedUpdater(root: string, machineDir: string, port: number, job: Prepared,
  spawnImpl: typeof spawn = spawn): { ok: true; log: string } | { ok: false; reason: string } {
  const log = newLogFile(machineDir);
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const fd = fs.openSync(log, "a", 0o600);
    const tsx = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const child = spawnImpl(tsx, [path.join(root, "scripts", "update.mts"), "--from-server",
      "--tag", job.tag, "--lock-token", job.token, "--log", log, "--port", String(port)], {
      cwd: root, detached: true, stdio: ["ignore", fd, fd],
      env: { ...process.env, AUTOCREW_LOCAL_DIR: machineDir, AUTOCREW_PORT: String(port) },
    });
    fs.closeSync(fd);
    child.on("error", () => releaseLock(machineDir, job.token));
    child.unref();
    return { ok: true, log };
  } catch (e) {
    releaseLock(machineDir, job.token);
    return { ok: false, reason: `更新进程起不来：${e instanceof Error ? e.message : String(e)}` };
  }
}
