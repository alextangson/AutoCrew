/**
 * 总编辑的后端清单（spec §目标 / §地基 14）。
 *
 * 每家本机后端 = 一条启动命令 + 一段差异适配（session/new 的 _meta、权限选项过滤、
 * 认证失败的认法）。阶段 1 只接 Claude；Codex / WorkBuddy 在这里挂「即将支持」，
 * 阶段 2 补上各自的启动命令与 quirks（spikes/acp-local-agent/RESULTS.md 已记好）。
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

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
}

export interface BackendAdapter {
  id: LocalBackendId;
  label: string;
  /** 计费口径（§地基 14）：不笼统承诺走订阅 */
  billing: string;
  launch(): LaunchSpec | null;
  /** session/new 与 session/load 的 _meta（强制权限提示等差异适配） */
  sessionMeta(): Record<string, unknown>;
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
    return entry ? { command: process.execPath, args: [entry] } : null;
  },
  sessionMeta() {
    return {
      claudeCode: {
        options: {
          settings: { permissions: { ask: CLAUDE_ASK_TOOLS, defaultMode: "default" } },
          allowDangerouslySkipPermissions: false,
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
