/**
 * 不花额度的检测（spec §2.2 / O2）：只看文件在不在、`codex login status`。
 * 真调一次模型只在「检测登录」按钮里（probe.ts）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { listHostTokens } from "../host-tokens.js";
import { appInstalled, findDesktopClaude, findOnPath, type HostEnv } from "./env.js";
import { readMcpEntry } from "./mcp-json-file.js";
import { readVerifyState } from "./verify-state.js";

export const CONNECT_HOSTS = ["claude", "codex", "workbuddy"] as const;
export type ConnectHost = (typeof CONNECT_HOSTS)[number];

/** 接入命令里的名字 → 令牌 / AUTOCREW_HOST 里的宿主名 */
export const TOKEN_HOST: Record<ConnectHost, string> = { claude: "claude-code", codex: "codex", workbuddy: "workbuddy" };
export const HOST_LABEL: Record<ConnectHost, string> = { claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy" };

/** 「claude-code」也认：老命令和令牌名都叫这个 */
export function parseConnectHost(value: string): ConnectHost | null {
  const v = value.trim().toLowerCase();
  if (v === "claude-code") return "claude";
  return (CONNECT_HOSTS as readonly string[]).includes(v) ? (v as ConnectHost) : null;
}

export interface ClaudeCli { path: string; source: "path" | "desktop" }

export function findClaudeCli(env: HostEnv): ClaudeCli | null {
  const onPath = findOnPath("claude", env);
  if (onPath) return { path: onPath, source: "path" };
  const bundled = findDesktopClaude(env.home);
  return bundled ? { path: bundled, source: "desktop" } : null;
}

export interface HostStatus {
  host: ConnectHost;
  label: string;
  found: boolean;
  /** null = 没查（Claude 平时不查登录，点「检测登录」才知道） */
  loggedIn: boolean | null;
  /** 给人看的一句状态 */
  detail: string;
  /** 宿主配置里有 autocrew 条目、令牌还在、且上一次核对过能连上 */
  connected: boolean;
  /** 条目和令牌都在，但上一次没核对上（或从没核对过）：原因 */
  unverified?: string;
  lastUsedAt?: string;
}

export function codexConfigFile(env: HostEnv): string {
  return path.join(env.codexHome, "config.toml");
}

/** config.toml 里有没有 [mcp_servers.autocrew]——只看表头，不为这一件事引 TOML 解析器 */
export function codexHasEntry(env: HostEnv): boolean {
  try {
    const raw = readFileSync(codexConfigFile(env), "utf-8");
    return /^\s*\[\s*mcp_servers\.(?:autocrew|"autocrew")\s*\]/m.test(raw);
  } catch {
    return false;
  }
}

export function workbuddyConfigFile(env: HostEnv): string {
  return path.join(env.home, ".workbuddy", "mcp.json");
}

/** 配置里有没有我们的条目（只读） */
export function hasEntry(host: ConnectHost, env: HostEnv): boolean {
  if (host === "codex") return codexHasEntry(env);
  const r = readMcpEntry(host === "claude" ? env.claudeConfig : workbuddyConfigFile(env));
  return !("error" in r) && r.entry !== undefined;
}

async function detectCodex(env: HostEnv): Promise<Pick<HostStatus, "found" | "loggedIn" | "detail">> {
  const cli = findOnPath("codex", env);
  if (!cli) return { found: false, loggedIn: null, detail: "没找到 Codex，装好后回来点一下" };
  const r = await env.run(cli, ["login", "status"], { timeoutMs: 8_000 });
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.failure) return { found: true, loggedIn: null, detail: `查不了 Codex 登录状态（${r.failure === "timeout" ? "超时" : r.failure}），可以先接上再说` };
  // 127 = 命令本身跑不起来（多半找不到 node），和「没登录」是两回事
  if (r.code === 127 || r.code === 126) return { found: true, loggedIn: null, detail: `找到了 codex，但它起不来（退出码 ${r.code}，多半是找不到 node）：在终端运行 codex --version 看看` };
  const loggedIn = r.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
  return { found: true, loggedIn, detail: loggedIn ? "已登录" : "Codex 还没登录：在终端运行 codex login，再回来点一下" };
}

function detectClaude(env: HostEnv): Pick<HostStatus, "found" | "loggedIn" | "detail"> {
  const cli = findClaudeCli(env);
  const desktop = appInstalled("Claude.app", env) && existsSync(path.join(env.home, ".claude"));
  if (!cli && !desktop) return { found: false, loggedIn: null, detail: "没找到 Claude Code，装好后回来点一下" };
  return { found: true, loggedIn: null, detail: cli?.source === "path" ? "找到了 Claude Code" : "找到了 Claude 桌面版" };
}

function detectWorkbuddy(env: HostEnv): Pick<HostStatus, "found" | "loggedIn" | "detail"> {
  const found = appInstalled("WorkBuddy.app", env) || existsSync(path.join(env.home, ".workbuddy"));
  return { found, loggedIn: null, detail: found ? "找到了 WorkBuddy" : "没找到 WorkBuddy，装好后回来点一下" };
}

export async function detectHost(host: ConnectHost, env: HostEnv): Promise<HostStatus> {
  const base = host === "claude" ? detectClaude(env) : host === "codex" ? await detectCodex(env) : detectWorkbuddy(env);
  const token = listHostTokens(env.dataDir).find((t) => t.host === TOKEN_HOST[host]);
  const registered = Boolean(token) && hasEntry(host, env);
  const record = readVerifyState(env.dataDir)[host];
  const connected = registered && record?.verified === true;
  const unverified = registered && !connected ? (record?.reason ?? "还没核对过能不能连上") : undefined;
  return { host, label: HOST_LABEL[host], ...base, connected, ...(unverified ? { unverified } : {}), ...(token?.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}) };
}

/** 找到且（已知）已登录的排前面；其余保持 Claude → Codex → WorkBuddy */
export async function detectHosts(env: HostEnv): Promise<HostStatus[]> {
  const all = await Promise.all(CONNECT_HOSTS.map((h) => detectHost(h, env)));
  const rank = (s: HostStatus) => (s.found ? (s.loggedIn === false ? 1 : 0) : 2);
  return all.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((x) => x.s);
}
