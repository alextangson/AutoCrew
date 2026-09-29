/**
 * 总编辑的后端清单（spec §目标 / §地基 14）。
 *
 * 每家本机后端 = 一条启动命令 + 一段差异适配（session/new 的 _meta、权限选项过滤、
 * 认证失败的认法）。阶段 1 只接 Claude；Codex / WorkBuddy 在这里挂「即将支持」，
 * 阶段 2 补上各自的启动命令与 quirks（spikes/acp-local-agent/RESULTS.md 已记好）。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { StdioMcpSpec } from "./acp-process.js";

export const LOCAL_BACKENDS = ["claude", "codex", "workbuddy"] as const;
export type LocalBackendId = (typeof LOCAL_BACKENDS)[number];
export type BackendId = LocalBackendId | "builtin";

export function isLocalBackend(v: unknown): v is LocalBackendId {
  return typeof v === "string" && (LOCAL_BACKENDS as readonly string[]).includes(v);
}
export function isBackendId(v: unknown): v is BackendId {
  return v === "builtin" || isLocalBackend(v);
}

export interface PermissionOptionLike {
  optionId: string;
  kind: string;
  name?: string;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  /** 叠在白名单环境之上的变量（如创始人 settings 里的代理） */
  env?: Record<string, string>;
}

/** 创始人全局 settings 的 env 里，只有这两类跟 Claude 的线路有关；GitHub 令牌等一概不带 */
const ROUTING_ENV_KEY = /^(ANTHROPIC_|CLAUDE_CODE_)/;

/**
 * 减负后不再加载全局 settings，但线路必须照旧走创始人的代理（2026-09-29 创始人：必须经过代理）。
 * 只从 settings 文件取，不从宿主进程取（宿主会话自己的 ANTHROPIC_BASE_URL 会让认证失败，spike 实测）。
 * 文件不存在 = 这台机器没配代理（别的用户的常态），照常直连；
 * 文件在但读不出 / 结构不对 / 线路变量不是字符串 = 报错，绝不静默直连。
 * 报错不带解析器原文：JSON.parse 的报错会夹带附近的配置片段（可能是别的密钥）。
 */
export function claudeRoutingEnv(settingsPath = path.join(os.homedir(), ".claude", "settings.json")): { env: Record<string, string> } | { error: string } {
  if (!existsSync(settingsPath)) return { env: {} };
  const bad = (why: string) => ({ error: `${settingsPath} ${why}，不知道该走哪条代理，这一轮不发。修好这个文件再重发。` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return bad("读不了或不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bad("的顶层不是对象");
  const block = (parsed as { env?: unknown }).env;
  if (block === undefined) return { env: {} };
  if (!block || typeof block !== "object" || Array.isArray(block)) return bad("的 env 不是对象");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(block)) {
    if (!ROUTING_ENV_KEY.test(k)) continue;
    if (typeof v !== "string") return bad(`的 env.${k} 不是字符串`);
    env[k] = v;
  }
  return { env };
}

/**
 * 代理没开时 agent 会卡在重连上一声不吭（实测指向空端口 60 秒无输出）。
 * 拉起 agent 前先敲一下代理的端口，连不上当场说清楚；不是代理问题（没配 / 地址解析不了）就放行。
 */
export async function proxyUnreachable(env: Record<string, string>, timeoutMs = 1500): Promise<string | null> {
  const raw = env.ANTHROPIC_BASE_URL;
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return `代理地址 ${raw} 写得不对（~/.claude/settings.json 的 ANTHROPIC_BASE_URL），这一轮不发。`; }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const ok = await new Promise<boolean>((resolve) => {
    // WHATWG URL 给 IPv6 留着方括号（[::1]），net.connect 要裸地址
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const sock = net.connect({ host, port });
    const done = (v: boolean) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
  return ok ? null : `连不上代理 ${url.host}：先把代理开起来再重发。不会绕过代理直连。`;
}

/**
 * Headroom 把大段工具结果压成摘要 + 标记，让模型要原文时调 headroom_retrieve——这个工具来自
 * `headroom mcp serve`。减负后只挂 AutoCrew 的 MCP，模型照标记去调就报「No such tool」（2026-09-29 真机）。
 * 所以代理是 Headroom 时把它的 MCP 一起挂上；是 Headroom 却找不到命令就报错，不让 agent 带着取不回的原文干活。
 */
export async function headroomMcp(
  env: Record<string, string>,
  findBin: () => string | null = findHeadroomBin,
  timeoutMs = 1500,
): Promise<{ server?: StdioMcpSpec } | { error: string }> {
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return {};
  let service: unknown;
  try {
    const res = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(timeoutMs) });
    service = ((await res.json()) as { service?: unknown }).service;
  } catch {
    return {}; // 不是 Headroom（或没有 /health）：普通代理，不用挂
  }
  if (service !== "headroom-proxy") return {};
  const bin = findBin();
  if (!bin) return { error: "代理是 Headroom，但找不到 headroom 命令：没有它 agent 取不回被压缩的原文。装好 Headroom CLI（或确认它在 ~/.local/bin）再重发。" };
  return { server: { name: "headroom", command: bin, args: ["mcp", "serve", "--proxy-url", base] } };
}

function findHeadroomBin(): string | null {
  const dirs = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "").split(":")];
  for (const d of dirs) if (d && existsSync(path.join(d, "headroom"))) return path.join(d, "headroom");
  return null;
}

export interface BackendAdapter {
  id: LocalBackendId;
  label: string;
  /** 计费口径（§地基 14）：不笼统承诺走订阅 */
  billing: string;
  launch(): LaunchSpec | null;
  /** 线路环境（代理等）；读不出来就回 error，调用方不许退回直连 */
  routingEnv?(settingsPath?: string): { env: Record<string, string> } | { error: string };
  /** session/new 与 session/load 的 _meta（强制权限提示等差异适配） */
  /** env：线路变量，写进最高优先级的会话 settings，项目 settings 盖不掉 */
  sessionMeta(env?: Record<string, string>): Record<string, unknown>;
  /** 认证失败的认法：命中就标「未登录」并给修法 */
  isAuthError(message: string): boolean;
  loginFix: string;
}

/**
 * Claude 权限：创始人全局 settings 里 allow 了 Bash/Write/Edit，默认根本不弹权限。
 * 经 flag settings（最高优先级）下发 ask 规则压过 allow，不改全局设置、不丢技能/记忆
 * （spike 已验证允许/拒绝都生效）。旁路模式一并关掉。
 */
const CLAUDE_ASK_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"];

function resolveClaudeAdapter(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("@agentclientprotocol/claude-agent-acp/package.json");
    const entry = path.join(path.dirname(pkg), "dist", "index.js");
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

export const CLAUDE_ADAPTER: BackendAdapter = {
  id: "claude",
  label: "本机 Claude",
  billing: "用你的 Claude 订阅",
  launch() {
    const entry = resolveClaudeAdapter();
    // 走代理（Headroom）时 Claude 会关掉工具说明按需加载，AutoCrew 全部工具说明开局就占满；
    // 强制打开：2026-09-29 实测经 Headroom 首轮 67,616 → 30,847 token，工具照样能找到并调用
    return entry ? { command: process.execPath, args: [entry], env: { ENABLE_TOOL_SEARCH: "true" } } : null;
  },
  routingEnv: (settingsPath) => claudeRoutingEnv(settingsPath),
  sessionMeta(env = {}) {
    return {
      claudeCode: {
        options: {
          // AutoCrew 自己的 MCP 工具不弹权限卡：它们的门在服务端（执行前审批、认领、限权）
          // env 同时写进这里：Claude Code 会在进程环境之后套用 settings.env，只放进程环境会被项目 settings 盖掉
          settings: { permissions: { ask: CLAUDE_ASK_TOOLS, allow: ["mcp__autocrew", "mcp__headroom"], defaultMode: "default" }, env },
          allowDangerouslySkipPermissions: false,
          // 减负（v1.1）：只读本目录（人设 + AutoCrew 自带技能），不加载创始人全局的技能/插件/MCP；
          // 全局 settings 里的线路变量（代理）另由 routingEnv 取出，进程环境 + 上面 settings.env 各放一份，必须经过代理；
          // 登录走钥匙串，不受影响。实测首轮上下文 75k→18k，全局 model=opus 带来的 200k 窗口也不再生效
          settingSources: ["project"],
          strictMcpConfig: true,
        },
      },
    };
  },
  isAuthError: (m) => /failed to authenticate|oauth|not logged in|please run \/login|invalid api key/i.test(m),
  loginFix: "在终端运行 `claude` 并按提示登录，再回来重发这条消息",
};

export const ADAPTERS: Partial<Record<LocalBackendId, BackendAdapter>> = { claude: CLAUDE_ADAPTER };

/** 权限选项只留「允许一次 / 拒绝」（v1 不做「本对话都允许」，§地基 3） */
export function pickPermissionOption(options: PermissionOptionLike[], decision: "allow" | "deny"): string | null {
  const want = decision === "allow" ? "allow_once" : "reject_once";
  return options.find((o) => o.kind === want)?.optionId ?? null;
}

export type BackendState = "ready" | "not_installed" | "not_logged_in" | "coming_soon" | "not_configured";

export interface BackendStatus {
  id: BackendId;
  label: string;
  billing?: string;
  state: BackendState;
  /** 给人看的一句话：状态原因 + 修法 */
  detail?: string;
}

const COMING_SOON: Record<"codex" | "workbuddy", { label: string; billing: string }> = {
  codex: { label: "本机 Codex", billing: "用你的 ChatGPT 订阅" },
  workbuddy: { label: "本机 WorkBuddy", billing: "用 WorkBuddy 额度" },
};

/**
 * 就绪状态。`claude auth status` 实测不可信（登录可用时也回 loggedIn:false），
 * 所以「未登录」只在最近一次真实调用报了认证错误后才标，下一次成功即清。
 */
export function backendStatuses(opts: { authFailed: ReadonlySet<LocalBackendId>; builtinConfigured: boolean }): BackendStatus[] {
  const claude = CLAUDE_ADAPTER;
  const claudeState: BackendState = !claude.launch()
    ? "not_installed"
    : opts.authFailed.has("claude") ? "not_logged_in" : "ready";
  const claudeDetail = claudeState === "not_installed"
    ? "Claude 适配器没装上：在 AutoCrew 目录运行 npm install"
    : claudeState === "not_logged_in" ? `上次调用报未登录：${claude.loginFix}` : undefined;
  return [
    { id: "claude", label: claude.label, billing: claude.billing, state: claudeState, ...(claudeDetail ? { detail: claudeDetail } : {}) },
    ...(["codex", "workbuddy"] as const).map((id): BackendStatus => ({ id, ...COMING_SOON[id], state: "coming_soon", detail: "即将支持" })),
    {
      id: "builtin",
      label: "内置引擎（备用）",
      state: opts.builtinConfigured ? "ready" : "not_configured",
      ...(opts.builtinConfigured ? {} : { detail: "内置引擎没配置：到设置页填端点后才能用" }),
    },
  ];
}
