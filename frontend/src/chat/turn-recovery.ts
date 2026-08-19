/**
 * 断线恢复契约的纯逻辑（对话控制面设计 §Phase 3）。
 *
 * 为什么单独一个模块：判定「上一轮到底怎么样了」是三态分支，值得单测；
 * ChatDock 只负责接线（查状态 → 按 action 做事），不藏判断。
 *
 * 服务端 turn 结果与客户端在不在线无关（chat-persist 照常落盘），所以恢复只做三件事：
 * done → 按返回的 conversationId 重拉会话（首轮响应丢了也能补上结果）；
 * running → 明说还在跑，别让用户以为消息蒸发了；
 * unknown → 明说这轮结果没保住、可以重发（服务端重启会走到这——不假装还在跑）。
 */

export interface PendingTurn {
  turnId: string;
  /** 发起时所在的会话（首轮为空——会话是这一轮才建的） */
  conversationId?: string;
}

export interface TurnStatusView {
  status: "running" | "done" | "unknown";
  conversationId?: string;
}

export type Recovery =
  | { action: "reload"; conversationId?: string }
  | { action: "wait"; notice: string }
  | { action: "lost"; notice: string };

export function decideRecovery(pending: PendingTurn, view: TurnStatusView): Recovery {
  if (view.status === "done") {
    // 服务端索引里的 conversationId 优先：首轮建的新会话只有它知道
    const conversationId = view.conversationId ?? pending.conversationId;
    return conversationId ? { action: "reload", conversationId } : { action: "reload" };
  }
  if (view.status === "running") {
    return { action: "wait", notice: "上一轮还在跑，跑完会自动出现在这里。" };
  }
  return { action: "lost", notice: "上一轮的结果没保住（服务可能重启过），可以直接重发。" };
}

/** sessionStorage 的最小面（node 测试注入假实现；浏览器给真的） */
export interface PendingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = "autocrew.chat.pendingTurn";

function defaultStore(): PendingStore | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // 隐私模式下访问 sessionStorage 会抛——没有记忆也不能让对话起不来
  }
}

export function writePendingTurn(pending: PendingTurn, store: PendingStore | null = defaultStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(pending));
  } catch {
    /* 存不下就没有恢复能力，不影响本轮 */
  }
}

export function readPendingTurn(store: PendingStore | null = defaultStore()): PendingTurn | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as PendingTurn;
    return typeof p.turnId === "string" && p.turnId
      ? { turnId: p.turnId, ...(typeof p.conversationId === "string" && p.conversationId ? { conversationId: p.conversationId } : {}) }
      : null;
  } catch {
    return null;
  }
}

export function clearPendingTurn(store: PendingStore | null = defaultStore()): void {
  try {
    store?.removeItem(KEY);
  } catch {
    /* 清不掉最多是下次多查一次 turn_status */
  }
}

/**
 * 随机 id。crypto.randomUUID 只在安全上下文可用——本地 server 用 LAN IP + http 打开时没有它，
 * 那时也不能让「发消息」直接崩，退化成随机串即可（turnId 只要够唯一）。
 */
export function randomId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}
