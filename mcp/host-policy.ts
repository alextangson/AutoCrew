/**
 * 按宿主限权（P6 spec §3.4）——服务端的硬门，不靠人设自觉。
 *
 * 2026-10-02 起所有命名宿主（claude-code / codex / workbuddy / dsh）能力一样：写稿、封面、剪辑、发布准备都能做。
 * 创始人「Claude 写、Codex 剪」只是习惯，不是规则，这里不再按宿主分工。
 * 只有创始人自己的决定任何宿主都代替不了：
 * - 采纳（`autocrew_content adoption`）在这里拒；
 * - 审片 / 认稿 / 选封面 / 「我发了」等由各工具对模型调用回 `founder_only`（不经这张表，见 production/decisions）。
 *
 * 只按宿主名判：MCP 层看得到的身份就是命名 token 的主体，看不到它此刻「扮演」哪个岗位。
 */
import type { McpAccessContext, McpPrincipal } from "./access.js";
import { LOCAL_HOST } from "../src/storage/local-store.js";

export type PolicyDecision = { ok: true } | { ok: false; error: string; result?: Record<string, unknown> };

/**
 * 所有命名宿主共用的硬拒（P6-e r3：模型转而用 `autocrew_content adoption` 替创作者记「采纳」——
 * 那是采纳率北极星的读数）。采纳是创作者自己的动作：只在工作台记，或发布时隐式推导；宿主不能代填。
 */
export const ADOPTION_HOST_DENIED = "采纳是创作者自己的动作：只在工作台记，或发布时隐式推导；宿主不能代填 autocrew_content adoption";
const HOST_DENIED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = { autocrew_content: new Set(["adoption"]) };

export function hostPolicy(host: string, tool: string, args: Record<string, unknown>): PolicyDecision {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (host !== LOCAL_HOST && HOST_DENIED_ACTIONS[tool]?.has(action)) return { ok: false, error: ADOPTION_HOST_DENIED };
  return { ok: true };
}

/**
 * 这个宿主能不能写稿：直接问上面的限权表（备料 + 交稿两步都放行才算）。
 * 引导完成页的开工提示靠它——限权表改了，提示自动跟着变。
 */
export function hostCanWrite(host: string): boolean {
  return hostPolicy(host, "autocrew_workflow", { action: "write" }).ok && hostPolicy(host, "autocrew_writer", { action: "submit" }).ok;
}

/** 接到 `McpAccessContext.authorize` 上：宿主名就是命名 token 的主体 */
export function hostAuthorize(host: string): NonNullable<McpAccessContext["authorize"]> {
  return async (_principal: McpPrincipal, tool: string, args: Record<string, unknown>) => hostPolicy(host, tool, args);
}

/**
 * 工具表面瘦身（P6 §3.7）：宿主会话默认不列的工具——老的一步生成/改写/润色线与低频管理面。
 * 只是不列：注册表不动，工作台/CLI/dsh 照样全有；宿主硬调照样执行，回执多一句 `host_note`。
 */
export const HOST_HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "autocrew_generate",
  "autocrew_rewrite",
  "autocrew_revise",
  "autocrew_humanize",
  "autocrew_style",
  "autocrew_memory",
  "autocrew_flywheel",
  "autocrew_pro_status",
  "autocrew_init",
]);

/** `tools/list` 按宿主过滤：`local-user`（工作台、老 token）全列；命名宿主去掉隐藏工具 */
export function hostListsTool(host: string, tool: string): boolean {
  return host === LOCAL_HOST || !HOST_HIDDEN_TOOLS.has(tool);
}

/** 宿主硬调了一个不列的工具：照常执行，回执带这一句，让它知道主路不在这儿 */
export function hiddenToolNote(host: string, tool: string): string | undefined {
  if (host === LOCAL_HOST || !HOST_HIDDEN_TOOLS.has(tool)) return undefined;
  return `${tool} 不在宿主工具清单里（留给工作台/CLI）；本次照常执行，写稿主路走 autocrew_workflow → autocrew_writer`;
}
