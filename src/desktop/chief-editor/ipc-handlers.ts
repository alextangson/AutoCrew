/**
 * 总编辑本机 agent 的 IPC 接线（spec §目标 / §地基 9 / 12 / 14）。
 *
 * - chat:turn：对话的后端以服务端记录为准（已有对话看 meta.backend，新对话才看 payload.backend）；
 *   本机后端强制带 turn_id / client_id；绝不自动降级到内置引擎。
 * - agent:backends：切换器的就绪状态（没装 / 未登录 / 可用 / 即将支持 / 未配置）+ 后台是否还在跑旧库。
 * - agent:pending：刷新/重连后重新挂上进行中的轮次与待处理卡片。
 * - agent:answer：审批卡 / 权限卡的应答，单次消费。
 */
import { getConversation, renameConversation, updateConversationAgent } from "../../storage/conversation-store.js";
import { enqueueConversationWrite } from "../chat-persist.js";
import { parseSettings } from "./agent-settings.js";
import { getDataDir } from "../../storage/local-store.js";
import { isBackendId, isLocalBackend } from "./backends.js";
import { getChiefEditor } from "./service.js";
import { parseViewContext, viewContextLine, type ChatViewContext } from "../chat-view-context.js";
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
  const viewContext = await parseViewContext(payload.context, dataDir);
  return runLocalTurn(svc, {
    message: str(payload.message),
    backend,
    turnId,
    clientId,
    dataDir: getDataDir(dataDir),
    ...(str(payload.conversation_id) ? { conversationId: str(payload.conversation_id) } : {}),
    ...(viewContext?.contentId ? { contentId: viewContext.contentId } : {}),
    promptContext: `${agentContextBlock(viewContext)}${str(payload._dispatch_context)}`,
    ...newConversationSettings(payload),
    onDelta: (e) => { try { ctx?.onChatDelta?.({ turnId, seq: seq++, ...e }); } catch { /* 推送失败不影响本轮 */ } },
    onProgress: (e) => { try { ctx?.onProgress?.({ ...e, runId }); } catch { /* 同上 */ } },
  });
}

/**
 * 视图上下文 → 本轮 prompt 前缀（与内置引擎的 contextBlock 同口径，只进 agent 不进持久历史）：
 * 「改这篇」「开头」才有所指。字段已在 parseViewContext 过白名单与存在性校验。
 */
export function agentContextBlock(ctx: ChatViewContext | undefined): string {
  if (!ctx) return "";
  const draft = ctx.contentId
    ? `用户正打开稿件《${ctx.contentTitle || "无标题"}》（id: ${ctx.contentId}${ctx.platform ? `，平台: ${ctx.platform}` : ""}）——「这篇」「开头」等指代默认指它，可用 autocrew_content get 读全文。`
    : "";
  const focus = ctx.revisionFocus
    ? `用户在改${ctx.revisionFocus.scope === "selection" ? `选中的这段：「${ctx.revisionFocus.selection ?? ""}」` : "整篇"}，修改意见针对它。`
    : "";
  const lines = [draft, focus, viewContextLine(ctx)].filter(Boolean);
  return lines.length ? `【当前上下文】${lines.join("\n")}\n\n` : "";
}

/** 新对话随首轮带来的设置（已有对话以 meta 为准，这里不看） */
function newConversationSettings(payload: Json): { newSettings?: ReturnType<typeof parseSettings>; newConversationAllow?: boolean } {
  if (str(payload.conversation_id) || !payload.agent_settings) return {};
  const { conversationAllow, ...settings } = parseSettings(payload.agent_settings);
  return { newSettings: settings, ...(conversationAllow ? { newConversationAllow: true } : {}) };
}

/**
 * agent:settings — 改一段对话的模型 / 强度 / 权限模式。下一轮才生效（进行中那轮开头已读定，U1）。
 * 「本对话都允许」只进内存（U5）；其余落 meta，走按会话串行队列，别和本轮落盘互相覆盖。
 */
export async function agentSettingsHandler(payload: Json): Promise<Json> {
  const id = str(payload.conversation_id);
  if (!id) return { ok: false, error: "需要 conversation_id（新对话的设置随第一条消息一起发）" };
  const dataDir = str(payload._dataDir) || undefined;
  const { conversationAllow, ...settings } = parseSettings(payload);
  const meta = await enqueueConversationWrite(id, () => updateConversationAgent(id, { agentSettings: settings }, dataDir));
  if (!meta) return { ok: false, error: "会话不存在或已损坏" };
  getChiefEditor()?.setConversationAllow(id, Boolean(conversationAllow));
  return { ok: true, data: { settings: meta.agentSettings ?? {}, conversationAllow: Boolean(conversationAllow) } };
}

/** conversations:rename — U6：空名不保存、截 40 字、后写覆盖；走按会话串行队列 */
export async function conversationRenameHandler(payload: Json): Promise<Json> {
  const id = str(payload.id);
  const title = typeof payload.title === "string" ? payload.title : "";
  if (!id) return { ok: false, error: "需要 id" };
  if (!title.trim()) return { ok: false, error: "标题不能为空，已保留原名" };
  const meta = await enqueueConversationWrite(id, () => renameConversation(id, title, str(payload._dataDir) || undefined));
  return meta ? { ok: true, data: { meta } } : { ok: false, error: "会话不存在或已损坏" };
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
  const conversationId = str(payload.conversation_id);
  const clientId = str(payload.client_id);
  const view = svc.pendingView({ dataDir: getDataDir(str(payload._dataDir) || undefined), ...(conversationId ? { conversationId } : {}), ...(clientId ? { clientId } : {}) });
  return { ok: true, data: { ...view, conversationAllow: conversationId ? svc.conversationAllowed(conversationId) : false } };
}

export async function agentAnswerHandler(payload: Json): Promise<Json> {
  const id = str(payload.ask_id);
  const decision = str(payload.decision);
  if (!id || !["allow", "deny", "allow_conversation"].includes(decision)) return { ok: false, error: "需要 ask_id 与 decision（allow / deny / allow_conversation）" };
  const svc = getChiefEditor();
  if (!svc) return { ok: false, error: "本机 agent 只能在本地守护进程里用" };
  // 「始终允许（本对话）」只对权限卡：业务审批（发布、删稿、删选题）永远一次一批
  const target = svc.asks.pending().find((a) => a.id === id);
  if (decision === "allow_conversation" && target?.kind !== "permission") return { ok: false, error: "业务审批不能「始终允许」，每次都要单独批准" };
  const r = svc.asks.answer(id, decision === "deny" ? "deny" : "allow");
  if (r.ok && decision === "allow_conversation") svc.setConversationAllow(r.ask.conversationId, true);
  return r.ok ? { ok: true, data: { ask: r.ask } } : r;
}
