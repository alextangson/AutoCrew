import type { InvokeResult } from "../transport";
import type { ChatCardShape } from "./cards";

interface ChatTurnData {
  reply?: unknown;
  cards?: unknown;
  conversationId?: unknown;
  conversation_id?: unknown;
  runId?: unknown;
  actionId?: unknown;
}

export interface ParsedChatTurnResponse {
  reply: string;
  cards: ChatCardShape[];
  conversationId?: string;
  actionId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * chat:turn 的正式契约是 { ok, data: { reply, cards, conversationId } }。
 * 旧 renderer 曾误读顶层 snake_case，导致“后端已回复、界面却是空白”，
 * 同时新会话拿不到 id，连续发言会被拆成多个 session。这里集中兼容新旧形状。
 */
export function parseChatTurnResponse(result: InvokeResult): ParsedChatTurnResponse {
  const data = record(result.data) as ChatTurnData;
  const rawReply =
    typeof data.reply === "string"
      ? data.reply
      : typeof result.reply === "string"
        ? result.reply
        : "";
  const cards = (Array.isArray(data.cards) ? data.cards : Array.isArray(result.cards) ? result.cards : []) as ChatCardShape[];
  const rawConversationId =
    data.conversationId ??
    data.conversation_id ??
    result.conversationId ??
    result.conversation_id;
  const conversationId = typeof rawConversationId === "string" && rawConversationId ? rawConversationId : undefined;
  const rawActionId = data.actionId ?? data.runId ?? result.actionId ?? result.runId;
  const actionId = typeof rawActionId === "string" && rawActionId ? rawActionId : undefined;
  const reply = rawReply.trim() ||
    (cards.length > 0
      ? "任务已完成，结果见下方卡片。"
      : "任务已提交，但总编辑没有返回可显示的说明。请在看板或工作日志查看状态。 ");

  return {
    reply: reply.trim(),
    cards,
    ...(conversationId ? { conversationId } : {}),
    ...(actionId ? { actionId } : {}),
  };
}
