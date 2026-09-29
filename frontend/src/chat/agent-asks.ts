/**
 * 本机 agent 的待处理卡（审批 / 权限）在前端的状态：SSE `agent` 事件 + agent:pending 重放合成一份列表。
 * 纯函数，便于测：卡片只看服务端 id，重复事件、已落定的卡都不会重复出现。
 */

export interface AskView {
  id: string;
  kind: "approval" | "permission";
  turnId: string;
  conversationId: string;
  status: string;
  expiresAt: string;
  title: string;
  detail: string;
}

function isAsk(v: unknown): v is AskView {
  const a = v as AskView | null;
  return Boolean(a) && typeof a!.id === "string" && (a!.kind === "approval" || a!.kind === "permission") && typeof a!.title === "string";
}

/** agent:pending 的回包 → 待处理卡 + 进行中的轮次 */
export interface RunningTurn { turnId: string; conversationId: string; status: string; owner: boolean; cards: LiveCard[] }

export interface LiveCard { type: string; callId?: string; data: Record<string, unknown>; background?: boolean }

export function parsePending(raw: unknown): { asks: AskView[]; running: RunningTurn | null } {
  const data = (raw as { data?: { asks?: unknown; running?: unknown } } | null)?.data;
  const asks = Array.isArray(data?.asks) ? data!.asks.filter(isAsk) : [];
  const r = data?.running as { turnId?: unknown; conversationId?: unknown; status?: unknown; owner?: unknown; cards?: unknown } | null | undefined;
  const running = r && typeof r.turnId === "string" && typeof r.conversationId === "string"
    ? { turnId: r.turnId, conversationId: r.conversationId, status: String(r.status ?? "running"), owner: r.owner === true, cards: mergeCards([], Array.isArray(r.cards) ? r.cards : []) }
    : null;
  return { asks, running };
}

/** SSE `agent` 事件并入列表：ask 加入（去重），ask_resolved 移除；只留当前对话的 */
export function applyAgentEvent(list: AskView[], event: Record<string, unknown>, conversationId?: string): AskView[] {
  const ask = event.ask;
  if (!isAsk(ask)) return list;
  if (event.type === "ask_resolved") return list.filter((a) => a.id !== ask.id);
  if (event.type !== "ask" || ask.status !== "pending") return list;
  if (conversationId && ask.conversationId !== conversationId) return list;
  return list.some((a) => a.id === ask.id) ? list : [...list, ask];
}

function isCard(v: unknown): v is LiveCard {
  const c = v as LiveCard | null;
  return Boolean(c) && typeof c!.type === "string" && typeof c!.data === "object" && c!.data !== null;
}

/** 本轮卡片按 callId 合并（SSE 实时帧 + 刷新后的快照可能重叠），顺序按首次出现 */
export function mergeCards(list: LiveCard[], incoming: unknown[]): LiveCard[] {
  const out = [...list];
  for (const c of incoming) {
    if (!isCard(c)) continue;
    if (c.callId && out.some((x) => x.callId === c.callId)) continue;
    out.push(c);
  }
  return out;
}

/**
 * agent:pending 的查询参数（评审 v1.2 P2-7）：undefined = 查右栏当前那段；null = 不限对话；
 * 给了 id 就查那段——重挂别处发起的轮（如看板重试）时右栏开着的可能是别的对话。
 */
export function pendingQuery(clientId: string, forConversation: string | null | undefined, current: string | undefined): Record<string, string> {
  const conv = forConversation === undefined ? current : forConversation ?? undefined;
  return { client_id: clientId, ...(conv ? { conversation_id: conv } : {}) };
}
