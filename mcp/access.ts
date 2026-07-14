/**
 * 远程 MCP 商业化接入边界。
 *
 * 本地版不需要账号体系；云端部署可把 OAuth/JWT 解析后的 principal、套餐授权
 * 与用量计费回调注入同一个协议处理器，而无需改写任何 AutoCrew Tool。
 */
export interface McpPrincipal {
  subject: string;
  plan: "local" | "free" | "pro" | "team" | "enterprise";
  workspaceId?: string;
}

export interface McpUsageEvent {
  subject: string;
  workspaceId?: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  occurredAt: string;
}

export interface McpAccessContext {
  principal: McpPrincipal;
  authorize?: (
    principal: McpPrincipal,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  recordUsage?: (event: McpUsageEvent) => Promise<void> | void;
}
