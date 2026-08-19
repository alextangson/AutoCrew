/**
 * chat:turn 的持久化编排（S2.8 主进程全权）：
 * 载入会话历史（最近 12 条纯文本，卡片不进上下文）→ runChatTurn →
 * 成功后 user+assistant 成对原子落盘 → data.conversationId 回传。
 *
 * 失败/needsSetup 不落盘；无 conversation_id 的首轮成功后才建会话（不留空壳）。
 * runTurn 为测试注入口（镜像 ChatToolDeps 模式）。
 *
 * 并发安全：同一 conversationId 的 appendTurn（read-modify-write）通过
 * module-level queue 串行化，避免两条并发 turn 互相覆盖消息对。
 * 注意：历史读取在写队列之外——同会话两条并发 turn 各自看到回合前的历史；
 * 落盘完整性由队列保证，renderer 侧约定 busy 时禁发（chatBusy 已做）。
 */
import { runChatTurn, type ChatHistoryMessage, type ChatProgressEvent, type ChatViewContext } from "./chat-router.js";
import {
  createConversation,
  getConversation,
  appendTurn,
} from "../storage/conversation-store.js";

const HISTORY_WINDOW = 12;

/** Per-conversation write queue — prevents interleaved read-modify-write on appendTurn */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  writeQueues.set(key, next);
  // Clean up map entry once this chain link settles (avoids unbounded growth).
  // then(cleanup, cleanup) — NOT finally(): finally() would create a new promise
  // that re-rejects with next's reason and is never handled (unhandledRejection).
  const cleanup = () => {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

export async function runPersistedChatTurn(params: {
  message: string;
  conversationId?: string;
  dataDir?: string;
  /** §C1 上下文只发给模型,不进持久历史（回放显示原文） */
  viewContext?: ChatViewContext;
  /** 任务动态/运行日志归属(chatTurnHandler 注入,透传到 runLoop logMeta) */
  runId?: string;
  /** 客户端生成的 turnId（设计 §Phase 3）:随 assistant 消息落盘,断线恢复凭它认领本轮 */
  turnId?: string;
  /** 用户中止信号:中止走 ok:true + stopReason="aborted",按正常轮落盘（不写失败轮） */
  signal?: AbortSignal;
  onEvent?: (e: ChatProgressEvent) => void;
  runTurn?: typeof runChatTurn;
}): Promise<Record<string, unknown>> {
  const run = params.runTurn ?? runChatTurn;
  const { message, conversationId, dataDir } = params;

  let history: ChatHistoryMessage[] = [];
  if (conversationId) {
    const conv = await getConversation(conversationId, dataDir);
    if (!conv) return { ok: false, error: "会话不存在或已损坏，请新建任务" };
    history = conv.messages
      .slice(-HISTORY_WINDOW)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  const result = await run({
    message,
    history,
    dataDir,
    ...(params.viewContext ? { viewContext: params.viewContext } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
  if (!result.ok) {
    // 防呆:失败轮也留痕（仅已有会话——首轮失败仍不建空壳,needsSetup 是配置态不是任务失败）。
    // 否则用户消息随失败蒸发,刷新后像什么都没发生过——这正是「写一半就没了」的体验根源之一。
    if (conversationId && !result.needsSetup) {
      const failNote = `⚠️ 本轮执行失败：${String(result.error ?? "未知错误")}。你的消息已保留,可以直接重发。`;
      await enqueue(conversationId, () =>
        appendTurn(conversationId, { content: message }, { content: failNote, cards: [] }, dataDir),
      ).catch(() => { /* 留痕失败不改变返回 */ });
    }
    return result;
  }

  const data = result.data as { reply?: unknown; cards?: unknown } | undefined;
  const cards = Array.isArray(data?.cards) ? (data.cards as Record<string, unknown>[]) : [];
  const rawReply = typeof data?.reply === "string" ? data.reply.trim() : "";
  // 持久层最后一道防线：历史中不再写入“有气泡、没内容”的 assistant 消息。
  const reply = rawReply ||
    (cards.length > 0
      ? "任务已完成，结果见下方卡片。"
      : "这轮任务已处理，但没有返回可显示说明。请在看板或工作日志查看状态。");

  // Serialize writes for existing conversations only (new conversations have no
  // prior concurrent writer — serialization only guards the read-modify-write path)
  const persist = async () => {
    const convId = conversationId ?? (await createConversation(message, dataDir)).id;
    const meta = await appendTurn(
      convId,
      { content: message },
      { content: reply, cards, ...(params.turnId ? { turnId: params.turnId } : {}) },
      dataDir,
    );
    if (!meta) console.warn("[chat-persist] 会话在回合中被删除，本轮未落盘：" + convId);
    return {
      ...result,
      data: { ...(result.data as Record<string, unknown>), conversationId: meta ? convId : null },
    };
  };

  if (conversationId) {
    return enqueue(conversationId, persist);
  }
  return persist();
}
