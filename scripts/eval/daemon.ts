/**
 * 行为 eval 的临时守护进程（P6-e）：每个 trial 一个，数据目录与端口都是临时的。
 *
 * 红线：生产守护进程（:4317）与 `~/.autocrew` 一律不碰——端口从 4600 起挑空闲的，
 * `AUTOCREW_DATA_DIR` 指向 trial 目录；守护进程的环境里**不**放 `AUTOCREW_TOKEN`
 * （放了会被当成 server-token，宿主令牌就认不出是 claude-code 了）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { ensureHostToken } from "../../src/desktop/host-tokens.js";

export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const FIRST_PORT = 4600;
const READY_TIMEOUT_MS = 90_000;
/** 本进程已发出去的端口：三个场景并行时不许撞号 */
const handedOut = new Set<number>();

export interface Daemon {
  port: number;
  dataDir: string;
  /** claude-code 宿主令牌（值，只进子进程环境，不打印） */
  token: string;
  stop: () => Promise<void>;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function pickPort(): Promise<number> {
  for (let port = FIRST_PORT; port < FIRST_PORT + 200; port++) {
    if (handedOut.has(port)) continue;
    handedOut.add(port);
    if (await portFree(port)) return port;
  }
  throw new Error("4600–4799 没有空闲端口");
}

/** 守护进程的环境：去掉宿主会话带进来的 token，数据目录与端口改成临时的 */
function daemonEnv(dataDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AUTOCREW_DATA_DIR: dataDir, AUTOCREW_PORT: String(port) };
  delete env.AUTOCREW_TOKEN;
  return env;
}

async function waitReady(port: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`守护进程提前退出（code ${proc.exitCode}）`);
    try {
      // 与 `autocrew status --brief`（SessionStart hook）同一口径：5xx 算没起——worktree 没构建
      // frontend/dist 时 GET / 回 503，hook 会对模型说「未运行」，整场 eval 就测歪了
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return;
      if (res.status === 503) throw new Error("GET / 回 503：先 npm run fe:build，否则 SessionStart hook 会报未运行");
    } catch (err) {
      if (err instanceof Error && err.message.includes("fe:build")) throw err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`守护进程 ${READY_TIMEOUT_MS / 1000}s 内没有应答 :${port}`);
}

function killTree(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.pid === undefined) return resolve();
    const timer = setTimeout(() => {
      try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* 已退 */ }
      resolve();
    }, 5_000);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
    try { process.kill(-proc.pid, "SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}

/** 起一个指向 dataDir 的守护进程，并给 claude-code 宿主发令牌 */
export async function startDaemon(dataDir: string, logFile: string): Promise<Daemon> {
  await fs.mkdir(dataDir, { recursive: true });
  const tokenFile = ensureHostToken("claude-code", dataDir);
  const token = (await fs.readFile(tokenFile, "utf-8")).trim();
  const port = await pickPort();
  const log = createWriteStream(logFile, { flags: "a" });
  const proc = spawn("npx", ["tsx", "desktop/server.ts"], {
    cwd: REPO_ROOT,
    env: daemonEnv(dataDir, port),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // 自成进程组：npx → tsx → node 一起收
  });
  proc.stdout!.pipe(log);
  proc.stderr!.pipe(log);
  try {
    await waitReady(port, proc);
  } catch (err) {
    await killTree(proc);
    throw err;
  }
  return { port, dataDir, token, stop: async () => { await killTree(proc); log.end(); handedOut.delete(port); } };
}

/** 与转发器 `newSessionNonce` 同形的会话 nonce：种子写进认领/交接账的会话名不暴露「这是 eval」 */
export function sessionNonce(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
/** 本进程种子调用默认用的会话（评分按 seed.json 里记的值把它排除在「模型会话」之外） */
export const SEED_SESSION = sessionNonce();

export interface McpReply {
  ok: boolean;
  isError: boolean;
  /** structuredContent（工具回执）；JSON-RPC 错误时为 {error} */
  result: Record<string, any>;
}

/** 经守护进程的 `/mcp` 发一条 JSON-RPC（种子与指纹用；模型那一侧走 stdio 转发器） */
export async function mcpRequest(d: Pick<Daemon, "port" | "token">, method: string, params: Record<string, unknown>, session = SEED_SESSION): Promise<Record<string, any>> {
  const res = await fetch(`http://127.0.0.1:${d.port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${d.token}`, "X-AutoCrew-Session": session },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`/mcp HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, any>;
}

export async function mcpCall(d: Pick<Daemon, "port" | "token">, name: string, args: Record<string, unknown>, session = SEED_SESSION): Promise<McpReply> {
  const reply = await mcpRequest(d, "tools/call", { name, arguments: args }, session);
  if (reply.error) return { ok: false, isError: true, result: { error: reply.error } };
  const result = (reply.result?.structuredContent ?? { text: reply.result?.content?.[0]?.text }) as Record<string, any>;
  const isError = Boolean(reply.result?.isError);
  return { ok: !isError && result.ok !== false, isError, result };
}
