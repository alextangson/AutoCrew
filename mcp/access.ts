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
  /**
   * 宿主名（P3 §4.1）——来自命名 token 的文件名，老 `server-token` 是 `local-user`。
   * 归因**不**依赖 `clientInfo`：无会话的 HTTP 上它没有稳定落点，只作日志补充。
   * `handleMcpRequest` 把它注进每次 `tools/call` 的 `_host` 参数。
   */
  host: string;
  /**
   * 宿主会话 nonce（P6 §3.8，**只做诊断，不做门禁**）：转发器每进程一个，经 `X-AutoCrew-Session`
   * 头带来；Codex HTTP 直连可带可不带，缺省 `unknown`。`handleMcpRequest` 注进 `_session` 参数。
   */
  session?: string;
  authorize?: (
    principal: McpPrincipal,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  recordUsage?: (event: McpUsageEvent) => Promise<void> | void;
}
