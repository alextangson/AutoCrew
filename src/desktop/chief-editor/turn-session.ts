/**
 * 起会话：initialize → 续原 session（续不上新开并说一句）→ 记下适配器上报的模型/强度清单 →
 * 按对话设置设模型/强度（清单里没有就报错点名，U3）。ACP session id 拿到即落盘。
 */
import { updateConversationAgent } from "../../storage/conversation-store.js";
import { enqueueConversationWrite } from "../chat-persist.js";
import type { AgentProcess, SessionInfo, StdioMcpSpec } from "./acp-process.js";
import { applySettings, reportedChoices, type AgentSettings } from "./agent-settings.js";
import type { BackendAdapter } from "./backends.js";
import type { ActiveTurn, ChiefEditor } from "./service.js";
import type { StreamGate } from "./turn-stream.js";

/** 线路：代理变量 + 随代理挂的 MCP（Headroom） */
export interface SessionRoute {
  env: Record<string, string>;
  extraMcp: StdioMcpSpec[];
}

export const SESSION_TIMEOUT_MS = 90_000;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}超过 ${Math.round(ms / 1000)} 秒没有响应`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function resumeOrNew(svc: ChiefEditor, turn: ActiveTurn, adapter: BackendAdapter, proc: AgentProcess, gate: StreamGate, route: SessionRoute, prior?: string): Promise<{ info: SessionInfo; notice?: string; fresh: boolean }> {
  const mcp = { url: svc.deps.mcpUrl, token: turn.token!, extra: route.extraMcp };
  const env = route.env;
  const init = await withTimeout(proc.initialize(), SESSION_TIMEOUT_MS, "适配器初始化");
  let notice: string | undefined;
  if (prior && init.loadSession) {
    gate.replaying = true;
    try {
      const info = await withTimeout(proc.loadSession(prior, svc.deps.home, mcp, adapter.sessionMeta(env)), SESSION_TIMEOUT_MS, "续会话");
      return { info, fresh: false };
    } catch {
      notice = "上次的会话续不上，已新开（之前的上下文 agent 看不到了）";
    } finally {
      gate.replaying = false;
    }
  } else if (prior) {
    notice = "这个后端不支持续会话，已新开";
  }
  const info = await withTimeout(proc.newSession(svc.deps.home, mcp, adapter.sessionMeta(env)), SESSION_TIMEOUT_MS, "新建会话");
  return { info, fresh: true, ...(notice ? { notice } : {}) };
}

export async function openSession(
  svc: ChiefEditor, turn: ActiveTurn, adapter: BackendAdapter, proc: AgentProcess, gate: StreamGate,
  opts: { prior?: string; settings: AgentSettings; route?: SessionRoute },
): Promise<{ sessionId: string; notice?: string }> {
  const { info, notice, fresh } = await resumeOrNew(svc, turn, adapter, proc, gate, opts.route ?? { env: {}, extraMcp: [] }, opts.prior);
  if (fresh) {
    // 走按会话串行队列、只补这一个字段：别和并发的改名 / 设置变更互相覆盖（评审 v1.1 P1-1）
    await enqueueConversationWrite(turn.conversationId, () => updateConversationAgent(turn.conversationId, { acpSessionId: info.sessionId }, turn.dataDir));
    svc.runs.patch(turn.turnId, { acpSessionId: info.sessionId });
  }
  if (info.configOptions.length) svc.rememberChoices(adapter.id, reportedChoices(info.configOptions));
  const finalOptions = await applySettings(proc, info.sessionId, info.configOptions, opts.settings);
  if (finalOptions.length) svc.rememberChoices(adapter.id, reportedChoices(finalOptions));
  return { sessionId: info.sessionId, ...(notice ? { notice } : {}) };
}
