/**
 * 按宿主限权（P6 spec §3.4；codex 评审 #9）——服务端的硬门，不靠人设自觉。
 *
 * Codex 在 P6 里只是剪辑工位：唯一的写动作是 `autocrew_video register`（外加撤回自己那一代交接），
 * 其余只读查询。写稿、审稿、发布都在 Claude 会话里做——人设写「不许调」挡不住模型照调，
 * 这里挡得住。别的宿主（claude-code / dsh / local-user）不受限。
 *
 * 只按宿主名判：MCP 层看得到的身份就是命名 token 的主体，看不到它此刻「扮演」哪个岗位。
 */
import type { McpAccessContext, McpPrincipal } from "./access.js";

export type PolicyDecision = { ok: true } | { ok: false; error: string };

export const CODEX_EDITOR_DENIED = "剪辑工位（codex）只允许 register/status 与只读查询；写稿与发布在 Claude 会话里做";

/** 工具 → 放行的 action（`*` = 整个工具放行） */
type Allowlist = Readonly<Record<string, ReadonlySet<string> | "*">>;

const HOST_ALLOWLISTS: Readonly<Record<string, Allowlist>> = {
  codex: {
    autocrew_video: new Set(["register", "status", "revoke"]),
    autocrew_content: new Set(["get"]),
    autocrew_desk: new Set(["inbox", "claim", "release"]),
    autocrew_status: "*",
  },
};

const DENIED_MESSAGE: Readonly<Record<string, string>> = { codex: CODEX_EDITOR_DENIED };

export function hostPolicy(host: string, tool: string, args: Record<string, unknown>): PolicyDecision {
  const allowlist = HOST_ALLOWLISTS[host];
  if (!allowlist) return { ok: true };
  const allowed = allowlist[tool];
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (allowed === "*" || (allowed && allowed.has(action))) return { ok: true };
  return { ok: false, error: DENIED_MESSAGE[host] ?? `宿主 ${host} 不允许调用 ${tool} ${action}` };
}

/** 接到 `McpAccessContext.authorize` 上：宿主名就是命名 token 的主体 */
export function hostAuthorize(host: string): NonNullable<McpAccessContext["authorize"]> {
  return async (_principal: McpPrincipal, tool: string, args: Record<string, unknown>) => hostPolicy(host, tool, args);
}
