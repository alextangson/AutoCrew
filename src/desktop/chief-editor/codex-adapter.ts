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
 * 只读 config.toml，找出要关掉的 MCP 名字。创始人配置里的 `autocrew`（指向 :4317 真库、带他的宿主令牌）也关：
 * 本会话的 AutoCrew 由 ACP session/new 另挂（绑定会话令牌与资料库），实测关掉同名配置后 ACP 那条照常可用。
 */
export function codexMcpNames(configToml: string): string[] {
  // 只认顶层表头：`[mcp_servers.x.env]` 这类子表不是一个服务（误当成服务会生成非法覆盖，适配器当场崩）
  return [...configToml.matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([^\].]+))\]\s*$/gm)].map((m) => m[1] ?? m[2]);
}

export const CODEX_FORCED = ["approval_policy=\"untrusted\"", "sandbox_mode=\"workspace-write\""];
const CODEX_FEATURES_OFF = ["apps", "plugins", "chronicle", "memories", "computer_use"];

export function codexArgs(configToml: string): string[] {
  const overrides = [
    ...CODEX_FORCED,
    ...codexMcpNames(configToml).map((n) => `mcp_servers.${n}.enabled=false`),
    ...CODEX_FEATURES_OFF.map((f) => `features.${f}=false`),
  ];
  return overrides.flatMap((o) => ["-c", o]);
}

export function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
}

export function codexLaunch(configPath = codexConfigPath(), entry = resolveCodexAcp()): LaunchSpec | null {
  if (!entry) return null;
  const toml = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  return { command: process.execPath, args: [entry, ...codexArgs(toml)] };
}

export const CODEX_ADAPTER: BackendAdapter = {
  id: "codex",
  label: "本机 Codex",
  billing: "用你的 ChatGPT 订阅",
  launch: () => codexLaunch(),
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
