/**
 * 本机目录里的四样东西（self-update §2/§3）：设置、最近一次检查、最近一次更新的结果、更新锁。
 * 都在机器目录（AUTOCREW_LOCAL_DIR / ~/.autocrew），不进资料库、不进仓库。
 */
import fs from "node:fs";
import path from "node:path";
import type { ReleaseNotes } from "./changelog.js";

export interface UpdateSettings { autoCheck: boolean; skipVersion?: string }

export interface UpdateStatus {
  checkedAt: string;
  current: string;
  /** origin/main 上最高的发布版（tag 去掉 v） */
  latest?: string;
  tag?: string;
  /** origin 公布的这个 tag 指向的提交：更新只合到它（不认本地 tag） */
  commit?: string;
  available: boolean;
  /** available=false 的原因：已是最新 / 本地比发布版新或分叉 */
  reason?: "up_to_date" | "local_ahead" | "diverged";
  /** 检查失败的人话原因（只在设置页显示） */
  error?: string;
  notes?: ReleaseNotes[];
}

export interface UpdateResult {
  ok: boolean;
  /** 「rolled_back」= 失败已退回；「stuck」= 退回也失败，要手动恢复 */
  outcome: "updated" | "rolled_back" | "stuck" | "not_started" | "cancelled" | "aborted";
  from: string;
  to: string;
  at: string;
  message: string;
  log: string;
  manualCommands?: string[];
  notes?: ReleaseNotes[];
  seen?: boolean;
  /** 「上次更新中断」的结果：对应的在途记录时刻（恢复好之前一直显示） */
  interruptedAt?: string;
}

export const files = (machineDir: string) => ({
  settings: path.join(machineDir, "update-settings.json"),
  status: path.join(machineDir, "update-status.json"),
  result: path.join(machineDir, "update-result.json"),
  lock: path.join(machineDir, "update.lock"),
  logDir: path.join(machineDir, "update-logs"),
});

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")) as T; } catch { return null; }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export function readSettings(machineDir: string): UpdateSettings {
  const raw = readJson<Partial<UpdateSettings>>(files(machineDir).settings);
  return { autoCheck: raw?.autoCheck !== false, ...(typeof raw?.skipVersion === "string" ? { skipVersion: raw.skipVersion } : {}) };
}

export function writeSettings(machineDir: string, patch: { autoCheck?: boolean; skipVersion?: string | null }): UpdateSettings {
  const next: UpdateSettings = { ...readSettings(machineDir) };
  if (typeof patch.autoCheck === "boolean") next.autoCheck = patch.autoCheck;
  if (patch.skipVersion === null) delete next.skipVersion;
  else if (typeof patch.skipVersion === "string") next.skipVersion = patch.skipVersion;
  writeJson(files(machineDir).settings, next);
  return next;
}

export const readStatus = (machineDir: string) => readJson<UpdateStatus>(files(machineDir).status);
export const writeStatus = (machineDir: string, s: UpdateStatus) => writeJson(files(machineDir).status, s);
export const readResult = (machineDir: string) => readJson<UpdateResult>(files(machineDir).result);
export const writeResult = (machineDir: string, r: UpdateResult) => writeJson(files(machineDir).result, r);

export function markResultSeen(machineDir: string): void {
  const r = readResult(machineDir);
  if (r && !r.seen) writeResult(machineDir, { ...r, seen: true });
}
