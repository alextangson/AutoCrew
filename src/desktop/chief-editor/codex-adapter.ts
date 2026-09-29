/**
 * 本机 Codex 后端（阶段 2，spec §接法 Codex 行；spike 结论见 spikes/acp-local-agent/RESULTS.md）。
 *
 * 锁 `@zed-industries/codex-acp` 0.16.0。Codex 只认它自己的 ~/.codex/config.toml，
 * 我们**不改、不复制**那份配置（复制会让登录刷新写到副本里、把创始人真正的登录搞坏），只用 `-c` 覆盖：
 * - 每个会话强制 approval_policy="untrusted" + sandbox_mode="workspace-write"（创始人全局是 never + danger-full-access，
 *   不覆盖就一次权限卡都不弹）；
 * - 减负：config.toml 里每个 mcp_servers.<名字>（含创始人自己配的 autocrew）置 enabled=false，并关掉 apps / plugins / chronicle / memories / computer_use
 *   这些会自带一批 MCP 的功能（实测首轮上下文 151,120 → 19,842 token）；AutoCrew MCP 由 ACP session/new 单独挂。
 *   model_provider / 登录照旧（它们不在被关掉的那些键里）。
 */
import { createRequire } from "node:module";
import { parse as parseToml } from "smol-toml";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackendAdapter, LaunchSpec } from "./backends.js";

function resolveCodexAcp(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("@zed-industries/codex-acp/package.json");
    const entry = path.join(path.dirname(pkg), "bin", "codex-acp.js");
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * 用真的 TOML 解析器读 config.toml（评审 P1-2：正则会漏掉带注释 / 缩进的表头、内联表、带引号的名字，
 * 漏掉一个就等于带着创始人的凭证把那个服务起起来）。创始人配置里的 `autocrew`（指向 :4317 真库）也关：
 * 本会话的 AutoCrew 由 ACP session/new 另挂，实测关掉同名配置后 ACP 那条照常可用。
 */
export function codexMcpNames(configToml: string): string[] {
  const doc = parseToml(configToml) as { mcp_servers?: unknown };
  const servers = doc.mcp_servers;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers) : [];
}

/**
 * `-c` 的键按点切分（codex-acp 0.16.0 的说明：「dotted path」）：名字里带点、空白或引号就没法写成一条能关掉它的覆盖
 * （评审 P2-4；带引号的写法在 0.16.0 上没法在不碰创始人登录的前提下核实）。这种名字**拒绝起 Codex**，说清楚——
 * 宁可不跑，也不带着一个关不掉的服务起来。
 */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

export const CODEX_FORCED = [
  "approval_policy=\"untrusted\"",
  "sandbox_mode=\"workspace-write\"",
  // 评审 P1-1：只覆盖 sandbox_mode 会继承创始人全局的 writable_roots / network_access（可能是 ["/"] 与 true）。
  // 钉死：只有工作目录可写；shell 不联网——查资料走 AutoCrew 的 scout（服务端抓页），不需要 agent 自己联网
  "sandbox_workspace_write.writable_roots=[]",
  "sandbox_workspace_write.network_access=false",
];
const CODEX_FEATURES_OFF = ["apps", "plugins", "chronicle", "memories", "computer_use"];

export function codexArgs(configToml: string): { args: string[] } | { error: string } {
  let names: string[];
  try {
    names = codexMcpNames(configToml);
  } catch {
    return { error: "读不懂 ~/.codex/config.toml（TOML 格式有误），没法确认要关掉哪些 MCP 服务，这一轮不起 Codex。先修好这个文件再发。" };
  }
  const unsafe = names.filter((n) => !SAFE_KEY.test(n));
  if (unsafe.length) return { error: `~/.codex/config.toml 里的 MCP 服务名「${unsafe.join("」「")}」带点或特殊字符，没法可靠地在本会话里关掉它，这一轮不起 Codex。改成只含字母数字、下划线、连字符的名字再发。` };
  const overrides = [
    ...CODEX_FORCED,
    ...names.map((n) => `mcp_servers.${n}.enabled=false`),
    ...CODEX_FEATURES_OFF.map((f) => `features.${f}=false`),
  ];
  return { args: overrides.flatMap((o) => ["-c", o]) };
}

/** 本守护进程用的 CODEX_HOME（没设就 ~/.codex）：扫描与子进程必须是同一个（评审 P2-5） */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function planFor(home: string): { args: string[] } | { error: string } {
  const file = path.join(home, "config.toml");
  return codexArgs(existsSync(file) ? readFileSync(file, "utf-8") : "");
}

export function codexLaunch(home = codexHome(), entry = resolveCodexAcp()): LaunchSpec | null {
  if (!entry) return null;
  const plan = planFor(home);
  // 显式把 CODEX_HOME 交给子进程：白名单环境会剥掉它，子进程就会去读 ~/.codex（另一个账号、没扫过的 MCP）
  return { command: process.execPath, args: [entry, ...("args" in plan ? plan.args : [])], env: { CODEX_HOME: home } };
}

export const CODEX_ADAPTER: BackendAdapter = {
  id: "codex",
  label: "本机 Codex",
  billing: "用你的 ChatGPT 订阅",
  launch: () => codexLaunch(),
  launchProblem: () => {
    const plan = planFor(codexHome());
    return "error" in plan ? plan.error : null;
  },
  // Codex 把思考强度报成 reasoning_effort（新版适配器；锁定的 0.16.0 实测不报，控件就显示「默认」）
  configIds: { model: "model", effort: "reasoning_effort" },
  sessionMeta: () => ({}),
  // 模型不在 Codex 自带清单里时，它把这句警告当正文吐出来（每轮都有，真机实测）
  cleanText: (chunk) => chunk.replace(/Model metadata for `[^`]*` not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.\s*/g, ""),
  // untrusted 模式下 Codex 连 MCP 调用都要批；AutoCrew 自己的工具直接放行（与 Claude 的 allow mcp__autocrew 同口径）
  isOwnMcpCall: (raw) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return r.server_name === "autocrew" || r.server === "autocrew";
  },
  isAuthError: (m) => /unauthori[sz]ed|401|not logged in|please (log|sign) in|codex login|authenticat|refresh token/i.test(m),
  loginFix: "在终端运行 `codex login` 并按提示登录，再回来重发这条消息",
};
