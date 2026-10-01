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

export function launchedByLauncher(machineDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const mine = env[LAUNCH_ENV]?.trim();
  if (!mine) return false;
  try { return fs.readFileSync(path.join(machineDir, LAUNCH_FILE), "utf-8").trim() === mine; } catch { return false; }
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
