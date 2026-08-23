/**
 * CDP 事件旁听 —— 抖音走「网络拦截」路线的前置件(spec §4.2 传输策略总表)。
 *
 * `CdpSession` 只处理带 id 的命令响应,**无 id 的事件帧被它直接丢弃**(cdp-session.ts:96)。
 * 抖音要旁听页面自己发出的 `Network.responseReceived`,必须拿到事件帧。
 *
 * 做法:不改基座,而是借 `CdpConnectOptions.createSocket` 这个既有注入点——我们造 socket,
 * 在交给 CdpSession 之前先挂一个自己的 `message` 监听。两个监听器共存于同一条 WebSocket,
 * 命令通道仍归 CdpSession 独占,我们只读事件,不发帧、不抢 id。
 */
import { CdpSession, type CdpConnectOptions } from "./cdp-session.js";

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export type CdpEventHandler = (ev: CdpEvent) => void;

export interface EventTap {
  /** 订阅;返回退订函数 */
  on(handler: CdpEventHandler): () => void;
  /** 测试注入点:把一帧原始 CDP 文本喂进来 */
  feed(raw: string): void;
}

export function createEventTap(): EventTap {
  const handlers = new Set<CdpEventHandler>();
  return {
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    feed(raw) {
      let msg: { id?: number; method?: string; params?: unknown; sessionId?: string };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return; // 坏帧不是我们的事,命令通道自己有超时兜底
      }
      if (typeof msg.id === "number" || typeof msg.method !== "string") return; // 命令响应,不是事件
      const ev: CdpEvent = {
        method: msg.method,
        params: (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Record<string, unknown>,
        sessionId: msg.sessionId,
      };
      for (const h of [...handlers]) {
        try {
          h(ev);
        } catch {
          // 一个订阅者炸掉不该带走整条事件流
        }
      }
    },
  };
}

/** 连接 chrome-cdp,同时拿到命令会话与事件流 */
export async function connectWithEventTap(
  opts: CdpConnectOptions = {},
): Promise<{ session: CdpSession; tap: EventTap }> {
  const tap = createEventTap();
  const session = await CdpSession.connect({
    ...opts,
    createSocket: (url) => {
      const ws = opts.createSocket ? opts.createSocket(url) : new WebSocket(url);
      ws.addEventListener("message", (ev) => tap.feed(String((ev as { data?: unknown }).data ?? "")));
      return ws;
    },
  });
  return { session, tap };
}

/**
 * 等一个命中的事件。超时返回 null——**「没等到」是抓取器要区分的输入**
 * (什么都没拦到 = timeout,拦到但不符 schema = schema_changed),不能吞成异常。
 */
export function waitForEvent(
  tap: EventTap,
  predicate: (ev: CdpEvent) => boolean,
  timeoutMs: number,
): Promise<CdpEvent | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: CdpEvent | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(v);
    };
    const off = tap.on((ev) => {
      if (predicate(ev)) finish(ev);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
  });
}
