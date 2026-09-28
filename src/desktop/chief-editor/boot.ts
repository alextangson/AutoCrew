/**
 * 守护进程里起总编辑本机 agent 服务：接好 MCP 执行、审批服务、SSE，并做启动恢复
 * （残留轮标中断 + 清孤儿进程组，spec §地基 7 / 8）。失败只记日志，不阻断守护进程启动。
 */
import { handleMcpRequest, normalizeSession } from "../../../mcp/server.js";
import { hostAuthorize } from "../../../mcp/host-policy.js";
import { getContent } from "../../storage/local-store.js";
import type { ApprovalBinding } from "../approval-gate.js";
import { spawnAcpAgent } from "./acp-process.js";
import { chiefEditorHome } from "./run-store.js";
import { initChiefEditor } from "./service.js";

/** MCP 上的主体名：会话令牌的调用一律记在它名下（不靠自报请求头） */
export const CHIEF_EDITOR_HOST = "chief-editor";

export async function startChiefEditor(opts: {
  port: number;
  approvals: {
    issue: (b: ApprovalBinding) => { token: string };
    consume: (token: string, b: ApprovalBinding) => { ok: true } | { ok: false; error: string };
  };
  broadcast: (data: Record<string, unknown>) => void;
}): Promise<void> {
  const svc = initChiefEditor({
    home: chiefEditorHome(),
    mcpUrl: `http://127.0.0.1:${opts.port}/mcp`,
    spawnAgent: spawnAcpAgent,
    approvals: opts.approvals,
    emit: opts.broadcast,
    execMcp: (request, dataDir, turnId) => handleMcpRequest(request, {
      principal: { subject: CHIEF_EDITOR_HOST, plan: "local" },
      host: CHIEF_EDITOR_HOST,
      session: normalizeSession(turnId),
      authorize: hostAuthorize(CHIEF_EDITOR_HOST),
    }, dataDir),
    getContent: async (id, dataDir) => {
      const c = await getContent(id, dataDir);
      return c ? { title: c.title, body: c.body, platform: c.platform ?? "", status: c.status } : null;
    },
  });
  try {
    const leftovers = await svc.recoverOnStartup();
    if (leftovers.length) console.log(`  [chief-editor] ${leftovers.length} 个本机 agent 轮次被中断，已在对话里留痕、进程组已清`);
  } catch (err) {
    console.error("[chief-editor] 启动恢复失败:", err instanceof Error ? err.message : err);
  }
}
