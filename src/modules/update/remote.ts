/**
 * 跨进程的两件事（self-update §3，Codex 审 P1）：
 * - 问正在跑的服务「你那边有没有对话轮在跑」：内置引擎的轮只在服务进程内存里，runs.json 看不见；
 * - 服务是不是启动器（npm start）起的：启动器记的是 tsx 的 pid，真正跑 server.ts 的是 tsx 拉起的另一个 node，
 *   所以不比 pid，比启动器发给这一次启动的一次性标记（启动器写文件、经环境变量交给服务）。
 */
import fs from "node:fs";
import path from "node:path";
import { getHostStateDir } from "../../storage/storage-roots.js";

export const LAUNCH_FILE = "autocrew.launch";
export const LAUNCH_ENV = "AUTOCREW_LAUNCH_NONCE";

/** 启动器这一次写下的标记（没有就是 null） */
export function launcherNonce(machineDir: string): string | null {
  try { return fs.readFileSync(path.join(machineDir, LAUNCH_FILE), "utf-8").trim() || null; } catch { return null; }
}

/**
 * 「由 npm start 管着」的唯一定义（e2e P1-1）：服务报的启动标记 = 启动器这一次写下的标记。
 * 服务自己拿环境变量里的标记来比，命令行 / 更新进程拿 `/__autocrew/launch` 报的标记来比；bin/autocrew.mjs 是同一条规则的 JS 版。
 */
export function managedBy(serverNonce: string | null | undefined, machineDir: string): boolean {
  const mine = launcherNonce(machineDir);
  return Boolean(serverNonce && mine && serverNonce === mine);
}

export function launchedByLauncher(machineDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return managedBy(env[LAUNCH_ENV]?.trim(), machineDir);
}

export type LaunchVia = "launcher" | "serve" | "other";

/** 服务怎么起的：npm run serve 起的 npm 会带上 npm_lifecycle_event=serve */
export function launchVia(env: NodeJS.ProcessEnv = process.env): LaunchVia {
  if (env[LAUNCH_ENV]) return "launcher";
  return env.npm_lifecycle_event === "serve" ? "serve" : "other";
}

/** 端口上的服务报的启动信息（不是 AutoCrew、连不上、旧版本没有这个端点 → null） */
export async function fetchLaunchInfo(port: number, fetchImpl: typeof fetch = fetch): Promise<{ nonce: string | null; via: LaunchVia } | null> {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/__autocrew/launch`, { signal: AbortSignal.timeout(2_000) });
    if (!r.ok) return null;
    const b = await r.json() as { nonce?: unknown; via?: unknown };
    const via = b.via === "launcher" || b.via === "serve" ? b.via : "other";
    return { nonce: typeof b.nonce === "string" ? b.nonce : null, via };
  } catch { return null; }
}

/** 命令行 / 更新进程看端口上的服务：在不在、是不是 npm start 起的那个、怎么起的 */
export async function launcherState(port: number, machineDir: string, up: boolean, fetchImpl: typeof fetch = fetch): Promise<{ running: boolean; managed: boolean; via: LaunchVia }> {
  if (!up) return { running: false, managed: false, via: "other" };
  const info = await fetchLaunchInfo(port, fetchImpl);
  return { running: true, managed: managedBy(info?.nonce, machineDir), via: info?.via ?? "other" };
}

function serverToken(): string {
  const fromEnv = process.env.AUTOCREW_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try { return fs.readFileSync(path.join(getHostStateDir(), "server-token"), "utf-8").trim(); }
  catch { throw new Error("找不到本机访问凭证（server-token）"); }
}

/** 服务那边的忙碌原因；null = 空闲。问不到（连不上、凭证不对、旧版本服务）就抛，调用方当「没法确认」处理 */
export async function serverBusy(port: number, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const token = serverToken();
  let r: Response;
  try {
    r = await fetchImpl(`http://127.0.0.1:${port}/api/update/busy`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
  } catch (e) { throw new Error(`问不到服务（${e instanceof Error ? e.message : String(e)}）`); }
  const body = await r.json().catch(() => null) as { ok?: boolean; busy?: string | null } | null;
  if (!r.ok || !body || body.ok !== true || !("busy" in body)) throw new Error(`服务没回答（HTTP ${r.status}）`);
  return body.busy ?? null;
}
