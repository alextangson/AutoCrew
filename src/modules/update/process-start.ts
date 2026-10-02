/**
 * 进程身份：pid + 启动时刻（UTC 秒）——pid 会被复用，两样都对上才算同一个进程。
 * 更新锁靠它判断持锁进程还在不在。原来放在总编辑本机 agent 的 run-store 里，
 * 本机 agent 后端删掉后（onboarding-connect，2026-10-02）搬到这里。
 * `ps lstart` 的文字随 TZ / 语言变，所以强制 TZ=UTC、LC_ALL=C 读再解析成秒比。
 */
import { execFileSync } from "node:child_process";

export interface ProcessIdentity { pid: number; start?: number }

/** 进程启动时刻（UTC 秒）；进程不在就是 null */
export function startEpoch(pid: number): number | null {
  let raw = "";
  try {
    raw = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).trim();
  } catch {
    return null;
  }
  const t = raw ? Date.parse(`${raw} GMT`) : NaN;
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

/** pid 在、且启动时刻（秒，容差 1 秒）对得上 */
export function ownerAlive(owner: ProcessIdentity, lookup: (pid: number) => number | null = startEpoch): boolean {
  const now = lookup(owner.pid);
  if (now === null) return false;
  return typeof owner.start === "number" ? Math.abs(now - owner.start) <= 1 : false;
}
