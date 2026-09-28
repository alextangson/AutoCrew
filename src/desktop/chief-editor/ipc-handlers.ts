/**
 * 总编辑本机 agent 的 IPC 接线（spec §目标 / §地基 9 / 12 / 14）。
 *
 * - chat:turn：对话的后端以服务端记录为准（已有对话看 meta.backend，新对话才看 payload.backend）；
 *   本机后端强制带 turn_id / client_id；绝不自动降级到内置引擎。
 * - agent:backends：切换器的就绪状态（没装 / 未登录 / 可用 / 即将支持 / 未配置）+ 后台是否还在跑旧库。
 * - agent:pending：刷新/重连后重新挂上进行中的轮次与待处理卡片。
 * - agent:answer：审批卡 / 权限卡的应答，单次消费。
 */
import { getConversation } from "../../storage/conversation-store.js";
import { getDataDir } from "../../storage/local-store.js";
import { isBackendId, isLocalBackend } from "./backends.js";
import { getChiefEditor } from "./service.js";
import { runLocalTurn } from "./turn.js";

type Json = Record<string, unknown>;

export interface ChatTurnCtx {
  onChatDelta?: (e: { turnId: string; seq: number; ev: "delta" | "reset" | "done"; text?: string }) => void;
  onProgress?: (e: Json) => void;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 这一轮该走哪个后端：已有对话以服务端记录为准，缺席 = 内置引擎（旧会话） */
export async function resolveTurnBackend(payload: Json, dataDir?: string): Promise<string> {
  const conversationId = str(payload.conversation_id);
  if (conversationId) {
    const conv = await getConversation(conversationId, dataDir);
    return conv?.meta.backend ?? "builtin";
  }
  return isBackendId(payload.backend) ? payload.backend : "builtin";
}

/** 本机后端的 chat:turn；返回 null = 该走内置引擎（交回原处理器） */
export async function maybeRunLocalTurn(payload: Json, ctx?: ChatTurnCtx): Promise<Json | null> {
  const dataDir = str(payload._dataDir) || undefined;
  const backend = await resolveTurnBackend(payload, dataDir);
  if (!isLocalBackend(backend)) return null;
  const turnId = str(payload.turn_id);
  const clientId = str(payload.client_id);
  if (!turnId || !clientId) return { ok: false, error: "本机后端需要 turn_id 与 client_id（请刷新页面后重发）" };
  const svc = getChiefEditor();
  if (!svc) return { ok: false, error: "本机 agent 只能在本地守护进程（autocrew start）里用" };
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  let seq = 0;
  const contextContent = (payload.context as Json | undefined)?.contentId;
  return runLocalTurn(svc, {
    message: str(payload.message),
    backend,
    turnId,
    clientId,
    dataDir: getDataDir(dataDir),
    ...(str(payload.conversation_id) ? { conversationId: str(payload.conversation_id) } : {}),
    ...(typeof contextContent === "string" && contextContent ? { contentId: contextContent } : {}),
    onDelta: (e) => { try { ctx?.onChatDelta?.({ turnId, seq: seq++, ...e }); } catch { /* 推送失败不影响本轮 */ } },
    onProgress: (e) => { try { ctx?.onProgress?.({ ...e, runId }); } catch { /* 同上 */ } },
  });
}

export async function agentBackendsHandler(payload: Json, builtinConfigured: (dataDir?: string) => Promise<boolean>): Promise<Json> {
  const dataDir = str(payload._dataDir) || undefined;
  const svc = getChiefEditor();
  const configured = await builtinConfigured(dataDir).catch(() => false);
  if (!svc) return { ok: true, data: { backends: [], running: null, unavailable: "本机 agent 只能在本地守护进程里用" } };
  return { ok: true, data: svc.statuses(configured, getDataDir(dataDir)) };
}

export async function agentPendingHandler(payload: Json): Promise<Json> {
  const svc = getChiefEditor();
  if (!svc) return { ok: true, data: { running: null, asks: [] } };
  return { ok: true, data: svc.pendingView(str(payload.conversation_id) || undefined) };
}

export async function agentAnswerHandler(payload: Json): Promise<Json> {
  const id = str(payload.ask_id);
  const decision = str(payload.decision);
  if (!id || (decision !== "allow" && decision !== "deny")) return { ok: false, error: "需要 ask_id 与 decision（allow / deny）" };
  const svc = getChiefEditor();
  if (!svc) return { ok: false, error: "本机 agent 只能在本地守护进程里用" };
  const r = svc.asks.answer(id, decision);
  return r.ok ? { ok: true, data: { ask: r.ask } } : r;
}
