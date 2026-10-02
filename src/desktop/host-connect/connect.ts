/**
 * 一键接入 / 断开的唯一实现（spec §3，O4）：引导页按钮、设置页「宿主」一行、`autocrew connect|disconnect` 都调这里。
 *
 * 接入 = 发宿主令牌 → 写宿主用户级配置（替换同名并备份）→ 核对真连上（O8）。
 * 核对：宿主自己的列表命令说连上（Claude 的 `claude mcp list` 会真起一次转发器做健康检查），
 * 且服务端看到该宿主令牌刚被用过；Codex 的列表不做健康检查、直写的配置没有列表命令，
 * 就由这里按配置里写的同一条命令起一次转发器、握一次手。
 * 断开 = 删条目（先备份）+ 撤令牌（O9）；令牌一撤，带 AUTOCREW_HOST 的转发器就连不上，不回落到 server-token。
 */
import { ensureHostToken, listHostTokens, revokeHostToken } from "../host-tokens.js";
import type { HostEnv } from "./env.js";
import { detectHost, findClaudeCli, HOST_LABEL, TOKEN_HOST, type ConnectHost } from "./detect.js";
import { cliFailure, codexListEntry, hostEntry, registerHost, unregisterHost } from "./register.js";
import { findOnPath } from "./env.js";
import { recordVerify } from "./verify-state.js";

export interface ConnectResult {
  ok: boolean;
  host: ConnectHost;
  /** 配置写进去了吗 */
  registered: boolean;
  /** 核对过真连上了吗（打勾的条件） */
  verified: boolean;
  /** 给人看的结果 */
  message: string;
  /** 没写成 / 没核对上的原因 */
  error?: string;
  code?: string;
  replaced?: boolean;
  backup?: string;
}

const USE_WINDOW_MS = 60_000; // 令牌「最后调用」节流到每分钟一次，所以「刚用过」放宽一分钟

function tokenUsedSince(host: ConnectHost, since: number, env: HostEnv): boolean {
  const t = listHostTokens(env.dataDir).find((x) => x.host === TOKEN_HOST[host]);
  return Boolean(t?.lastUsedAt && Date.parse(t.lastUsedAt) >= since - USE_WINDOW_MS);
}

/** 按配置里写的那条命令起一次转发器，发 initialize，看回的是结果还是错误 */
export async function handshake(host: ConnectHost, env: HostEnv): Promise<string | null> {
  const entry = hostEntry(host, env);
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "autocrew-connect-check", version: "1" } } };
  const run = await withEnv(env, entry.env).run(entry.command, entry.args, { input: `${JSON.stringify(init)}\n`, timeoutMs: 15_000, cwd: env.home });
  if (run.failure) return `转发器起不来（${run.failure === "timeout" ? "超时" : run.failure}）`;
  const line = run.stdout.split("\n").find((l) => l.trim());
  try {
    const reply = JSON.parse(line ?? "") as { result?: unknown; error?: { message?: string } };
    if (reply.result) return null;
    return reply.error?.message ?? "转发器回了一条看不懂的应答";
  } catch {
    return "转发器没有回应答";
  }
}

/** 子进程环境叠上条目自己的 env（与宿主起转发器时一致） */
function withEnv(env: HostEnv, extra: Record<string, string>): HostEnv {
  const childEnv = { ...env.childEnv, ...extra };
  return { ...env, childEnv, run: env.runWith(childEnv) };
}

async function verifyClaudeList(env: HostEnv): Promise<string | null> {
  const cli = findClaudeCli(env);
  if (!cli) return handshake("claude", env);
  const r = await env.run(cli.path, ["mcp", "list"], { cwd: env.home, timeoutMs: 90_000 });
  if (r.code !== 0 || r.failure) return cliFailure("claude", r);
  const line = r.stdout.split("\n").find((l) => /^autocrew:/.test(l.trim()));
  if (!line) return "Claude 的 MCP 列表里没看到 autocrew";
  if (/✔|connected/i.test(line) && !/✗|failed/i.test(line)) return null;
  return `Claude 说连不上 autocrew（${line.split(" - ").pop()?.trim() ?? line.trim()}）——多半是 AutoCrew 服务没在运行`;
}

async function verifyCodexList(env: HostEnv): Promise<string | null> {
  const cli = findOnPath("codex", env);
  if (!cli) return "找不到 codex 命令";
  const listed = await codexListEntry(env, cli);
  if ("error" in listed) return listed.error;
  if (!listed.entry) return "Codex 的 MCP 列表里没看到 autocrew";
  if (listed.entry.enabled === false) return "Codex 里 autocrew 被停用了：在 Codex 里重新启用它";
  return handshake("codex", env);
}

export async function verifyHost(host: ConnectHost, env: HostEnv, since: number): Promise<string | null> {
  const listProblem = host === "claude" ? await verifyClaudeList(env) : host === "codex" ? await verifyCodexList(env) : await handshake(host, env);
  if (listProblem) return listProblem;
  if (!tokenUsedSince(host, since, env)) return "配置写好了，但 AutoCrew 没收到它的调用：确认 AutoCrew 服务在运行，再点一次";
  return null;
}

function connectedMessage(host: ConnectHost, method: string, verified: boolean, reason?: string): string {
  const label = HOST_LABEL[host];
  const head = verified ? `已接上 ${label}，核对过能连上` : `已把 AutoCrew 写进 ${label} 的配置，但还没核对上：${reason}`;
  const tail = host === "claude"
    ? method === "claude-file"
      ? "。没找到 claude 命令，直接改了 ~/.claude.json：新开一个会话生效；如果新会话里看不到 autocrew，关掉 Claude 再点一次（它开着时可能把这次改动盖掉）"
      : "。新开一个会话就能用"
    : host === "workbuddy" ? "。重启 WorkBuddy 后生效" : "。新开一个 Codex 会话就能用";
  return `${head}${tail}`;
}

export async function connectHost(host: ConnectHost, env: HostEnv): Promise<ConnectResult> {
  const started = Date.now();
  const status = await detectHost(host, env);
  if (!status.found) return { ok: false, host, registered: false, verified: false, code: "not_installed", error: status.detail, message: status.detail };
  if (status.loggedIn === false) return { ok: false, host, registered: false, verified: false, code: "not_logged_in", error: status.detail, message: status.detail };
  try {
    ensureHostToken(TOKEN_HOST[host], env.dataDir);
  } catch (err) {
    const error = `没能建 ${HOST_LABEL[host]} 的令牌：${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, host, registered: false, verified: false, code: "token_failed", error, message: error };
  }
  const reg = await registerHost(host, env);
  if (!reg.ok) return { ok: false, host, registered: false, verified: false, code: reg.code, error: reg.error, message: reg.error };
  const reason = await verifyHost(host, env, started);
  try {
    recordVerify(host, { verified: reason === null, ...(reason ? { reason } : {}), at: new Date().toISOString() }, env.dataDir);
  } catch (err) {
    const error = `接好了，但没能记下核对结果：${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, host, registered: true, verified: false, code: "state_write_failed", error, message: error };
  }
  const replacedNote = reg.replaced ? `已替换原来的 autocrew 配置（备份在 ${reg.backup}）。` : "";
  return {
    ok: true, host, registered: true, verified: reason === null,
    message: `${replacedNote}${connectedMessage(host, reg.method, reason === null, reason ?? undefined)}`,
    ...(reason ? { error: reason, code: "not_verified" } : {}),
    replaced: reg.replaced, ...(reg.backup ? { backup: reg.backup } : {}),
  };
}

export async function disconnectHost(host: ConnectHost, env: HostEnv): Promise<ConnectResult> {
  const un = await unregisterHost(host, env);
  // 删条目失败也照样撤令牌：撤了它就连不上（O9），配置里剩下的条目只会报「令牌被拒」
  const revoked = revokeHostToken(TOKEN_HOST[host], env.dataDir);
  try { recordVerify(host, null, env.dataDir); } catch { /* 令牌已撤、条目已删：残留的核对记录只会让它显示「没接上」，不影响安全 */ }
  const label = HOST_LABEL[host];
  if (!un.ok) {
    const error = `${revoked ? "令牌已撤销，它再调用会被拒绝；" : ""}但没能从 ${label} 的配置里删掉 autocrew：${un.error}`;
    return { ok: false, host, registered: true, verified: false, code: "remove_failed", error, message: error };
  }
  const removed = un.removed ? `已从 ${label} 的配置里删掉 autocrew${un.backup ? `（备份在 ${un.backup}）` : ""}` : `${label} 的配置里本来就没有 autocrew`;
  return { ok: true, host, registered: false, verified: false, message: `${removed}；${revoked ? "令牌已撤销，它再调用会被拒绝" : "它本来就没有令牌"}。`, ...(un.backup ? { backup: un.backup } : {}) };
}
