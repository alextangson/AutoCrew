/**
 * `autocrew init [--host claude|codex|workbuddy] [--library <路径>] [--legacy migrate|keep] [--json]`
 * 退出码：0 全部完成 / 1 某一步失败（原因 + 下一步已打印）/ 2 要先问用户一句再重跑。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { defaultHostEnv } from "../src/desktop/host-connect/env.js";
import { formatInit, runInit } from "../src/desktop/init-run.js";
import { getMachineDir } from "../src/storage/storage-roots.js";
import type { SetupResult } from "../src/storage/library-setup.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : i >= 0 ? args[i + 1] : undefined;
};
const BASE = `http://127.0.0.1:${Number(process.env.AUTOCREW_PORT) || 4317}`;

/** 端口上是不是 AutoCrew（O21）：启动标记端点不要登录、不带资料 */
async function autocrewRunning(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/__autocrew/launch`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json() as { ok?: unknown }).ok === true;
  } catch { return false; }
}

async function serviceSetup(body: { target: string; legacy?: string }): Promise<SetupResult | null> {
  if (!(await autocrewRunning())) return null;
  const token = (await fs.readFile(path.join(getMachineDir(), "server-token"), "utf8")).trim();
  const res = await fetch(`${BASE}/api/library/setup`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const json = await res.json() as { ok: boolean; data?: SetupResult; status?: string; error?: string };
  if (json.ok && json.data) return json.data;
  if (json.status === "refused") return json as unknown as SetupResult;
  throw new Error(json.error ?? `服务回了 HTTP ${res.status}`);
}

const report = await runInit({ host: opt("host"), library: opt("library"), legacy: opt("legacy") }, { env: defaultHostEnv(), serviceSetup });
console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatInit(report));
process.exitCode = report.exitCode;
