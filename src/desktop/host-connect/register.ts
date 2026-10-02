/**
 * 往各宿主的用户级配置里写 / 删 autocrew 条目（spec §3）。
 *
 * - Claude Code：优先官方命令 `claude mcp add --scope user`（CLI 与桌面版 Code 页同读 user scope）；
 *   PATH 上没有就用桌面版自带的 claude；都没有才直写 ~/.claude.json（O11：Claude 开着时有并发风险，提示新开会话）。
 * - Codex：`codex mcp add`（stdio，AUTOCREW_HOST=codex），不再用临时环境变量。
 * - WorkBuddy：合并 ~/.workbuddy/mcp.json。
 * 改任何文件前先整份备份（O6）；已有同名用户级条目就替换并说出备份位置（O7）。项目级 .mcp.json 不碰。
 */
import { findOnPath, type HostEnv, type RunResult } from "./env.js";
import { codexConfigFile, codexHasEntry, findClaudeCli, TOKEN_HOST, workbuddyConfigFile, type ConnectHost } from "./detect.js";
import { backupFile, mergeMcpJson, readMcpEntry, removeMcpJson, SERVER_NAME } from "./mcp-json-file.js";

export type Method = "claude-cli" | "claude-file" | "codex-cli" | "workbuddy-file";

export type RegisterResult =
  | { ok: true; method: Method; file: string; replaced: boolean; backup?: string; cliPath?: string }
  | { ok: false; code: string; error: string };

export type UnregisterResult = { ok: true; removed: boolean; backup?: string; file: string } | { ok: false; error: string };

export function hostEntry(host: ConnectHost, env: HostEnv): { command: string; args: string[]; env: Record<string, string> } {
  return { command: env.forwarder.command, args: env.forwarder.args, env: { AUTOCREW_HOST: TOKEN_HOST[host], ...env.forwarder.env } };
}

/** 命令失败的人话：带上命令自己说的最后一行，不带整段输出 */
export function cliFailure(label: string, r: RunResult): string {
  if (r.failure === "missing") return `找不到 ${label} 命令`;
  if (r.failure === "timeout") return `${label} 命令超时没回应`;
  if (r.failure) return `${label} 命令起不来：${r.failure}`;
  const last = `${r.stderr}\n${r.stdout}`.trim().split("\n").filter(Boolean).pop() ?? "";
  return `${label} 命令失败（退出码 ${r.code}）${last ? `：${last.slice(0, 200)}` : ""}`;
}

function safeBackup(file: string): { backup?: string } | { error: string } {
  try {
    const b = backupFile(file);
    return b ? { backup: b } : {};
  } catch (err) {
    return { error: `改之前没能备份 ${file}：${err instanceof Error ? err.message : String(err)}。没有改任何东西。` };
  }
}

function envFlags(flag: string, e: Record<string, string>): string[] {
  return Object.entries(e).flatMap(([k, v]) => [flag, `${k}=${v}`]);
}

async function registerClaude(env: HostEnv): Promise<RegisterResult> {
  const entry = hostEntry("claude", env);
  const cli = findClaudeCli(env);
  if (!cli) {
    const r = mergeMcpJson(env.claudeConfig, { type: "stdio", ...entry });
    if (!r.ok) return { ok: false, code: "write_failed", error: r.error };
    return { ok: true, method: "claude-file", file: r.file, replaced: r.outcome === "updated", ...(r.backup ? { backup: r.backup } : {}) };
  }
  const existing = readMcpEntry(env.claudeConfig);
  if ("error" in existing) return { ok: false, code: "config_unreadable", error: existing.error };
  const b = safeBackup(env.claudeConfig);
  if ("error" in b) return { ok: false, code: "backup_failed", error: b.error };
  if (existing.entry !== undefined) {
    const rm = await env.run(cli.path, ["mcp", "remove", SERVER_NAME, "--scope", "user"], { cwd: env.home, timeoutMs: 30_000 });
    if (rm.code !== 0 || rm.failure) return { ok: false, code: "cli_failed", error: `${cliFailure("claude", rm)}。原来的配置没动${b.backup ? `（备份在 ${b.backup}）` : ""}。` };
  }
  const add = await env.run(cli.path, ["mcp", "add", "--scope", "user", SERVER_NAME, ...envFlags("-e", entry.env), "--", entry.command, ...entry.args], { cwd: env.home, timeoutMs: 30_000 });
  if (add.code !== 0 || add.failure) {
    const lost = existing.entry !== undefined ? `原来的 autocrew 条目已删，备份在 ${b.backup}` : "没有写进去";
    return { ok: false, code: "cli_failed", error: `${cliFailure("claude", add)}。${lost}。` };
  }
  return { ok: true, method: "claude-cli", file: env.claudeConfig, replaced: existing.entry !== undefined, cliPath: cli.path, ...(b.backup ? { backup: b.backup } : {}) };
}

/** `codex mcp list --json` 里的 autocrew；命令失败回 error */
export async function codexListEntry(env: HostEnv, cli: string): Promise<{ entry?: Record<string, unknown> } | { error: string }> {
  const r = await env.run(cli, ["mcp", "list", "--json"], { cwd: env.home, timeoutMs: 20_000 });
  if (r.code !== 0 || r.failure) return { error: cliFailure("codex", r) };
  try {
    const list = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    return { entry: Array.isArray(list) ? list.find((s) => s.name === SERVER_NAME) : undefined };
  } catch {
    return { error: "codex mcp list 的输出读不懂（Codex 版本可能太老），没有改任何东西" };
  }
}

async function registerCodex(env: HostEnv): Promise<RegisterResult> {
  const cli = findOnPath("codex", env);
  if (!cli) return { ok: false, code: "not_installed", error: "没找到 codex 命令，装好 Codex 后再点" };
  const listed = await codexListEntry(env, cli);
  if ("error" in listed) return { ok: false, code: "cli_failed", error: listed.error };
  const existed = listed.entry !== undefined || codexHasEntry(env);
  const file = codexConfigFile(env);
  const b = safeBackup(file);
  if ("error" in b) return { ok: false, code: "backup_failed", error: b.error };
  if (existed) {
    const rm = await env.run(cli, ["mcp", "remove", SERVER_NAME], { cwd: env.home, timeoutMs: 20_000 });
    if (rm.code !== 0 || rm.failure) return { ok: false, code: "cli_failed", error: `${cliFailure("codex", rm)}。原来的配置没动${b.backup ? `（备份在 ${b.backup}）` : ""}。` };
  }
  const entry = hostEntry("codex", env);
  const add = await env.run(cli, ["mcp", "add", SERVER_NAME, ...envFlags("--env", entry.env), "--", entry.command, ...entry.args], { cwd: env.home, timeoutMs: 20_000 });
  if (add.code !== 0 || add.failure) {
    return { ok: false, code: "cli_failed", error: `${cliFailure("codex", add)}。${existed ? `原来的 autocrew 条目已删，备份在 ${b.backup}` : "没有写进去"}。` };
  }
  return { ok: true, method: "codex-cli", file, replaced: existed, cliPath: cli, ...(b.backup ? { backup: b.backup } : {}) };
}

function registerWorkbuddy(env: HostEnv): RegisterResult {
  const r = mergeMcpJson(workbuddyConfigFile(env), { type: "stdio", ...hostEntry("workbuddy", env) });
  if (!r.ok) return { ok: false, code: "write_failed", error: r.error };
  return { ok: true, method: "workbuddy-file", file: r.file, replaced: r.outcome === "updated", ...(r.backup ? { backup: r.backup } : {}) };
}

export async function registerHost(host: ConnectHost, env: HostEnv): Promise<RegisterResult> {
  if (host === "claude") return registerClaude(env);
  if (host === "codex") return registerCodex(env);
  return registerWorkbuddy(env);
}

async function unregisterClaude(env: HostEnv): Promise<UnregisterResult> {
  const cli = findClaudeCli(env);
  if (!cli) return removeMcpJson(env.claudeConfig);
  const existing = readMcpEntry(env.claudeConfig);
  if ("error" in existing) return { ok: false, error: existing.error };
  if (existing.entry === undefined) return { ok: true, removed: false, file: env.claudeConfig };
  const b = safeBackup(env.claudeConfig);
  if ("error" in b) return { ok: false, error: b.error };
  const rm = await env.run(cli.path, ["mcp", "remove", SERVER_NAME, "--scope", "user"], { cwd: env.home, timeoutMs: 30_000 });
  if (rm.code !== 0 || rm.failure) return { ok: false, error: cliFailure("claude", rm) };
  return { ok: true, removed: true, file: env.claudeConfig, ...(b.backup ? { backup: b.backup } : {}) };
}

async function unregisterCodex(env: HostEnv): Promise<UnregisterResult> {
  const file = codexConfigFile(env);
  if (!codexHasEntry(env)) return { ok: true, removed: false, file };
  const cli = findOnPath("codex", env);
  if (!cli) return { ok: false, error: `没找到 codex 命令，删不了 ${file} 里的 autocrew 条目；可以手动删掉 [mcp_servers.autocrew] 那一段` };
  const b = safeBackup(file);
  if ("error" in b) return { ok: false, error: b.error };
  const rm = await env.run(cli, ["mcp", "remove", SERVER_NAME], { cwd: env.home, timeoutMs: 20_000 });
  if (rm.code !== 0 || rm.failure) return { ok: false, error: cliFailure("codex", rm) };
  return { ok: true, removed: true, file, ...(b.backup ? { backup: b.backup } : {}) };
}

export async function unregisterHost(host: ConnectHost, env: HostEnv): Promise<UnregisterResult> {
  if (host === "claude") return unregisterClaude(env);
  if (host === "codex") return unregisterCodex(env);
  return removeMcpJson(workbuddyConfigFile(env));
}
