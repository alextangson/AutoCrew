/**
 * Transport（frontend-v2 A 期）——与本地 server 的唯一通道:
 * invoke = POST /api/invoke {channel, payload};SSE = /api/events(engine/chat 双流)。
 * 启动配置来自 /config.js 注入的公开通道表；认证走 HttpOnly session cookie。
 */

export interface AutocrewConfig {
  /** 兼容旧构建；安全会话上线后永远为空，不是凭证。 */
  token: string;
  channels: string[];
  methodMap: Record<string, string>;
}

declare global {
  interface Window {
    __AUTOCREW?: AutocrewConfig;
  }
}

export function getConfig(): AutocrewConfig {
  const cfg = window.__AUTOCREW;
  if (!cfg?.methodMap) {
    throw new Error("启动配置缺失:请从 AutoCrew 本地 server 打开的页面进入(/config.js 未注入)");
  }
  return cfg;
}

let sessionPromise: Promise<void> | null = null;

/** 把地址栏的一次性 boot token 换成 HttpOnly session cookie，并立即清掉 URL 中的 token。 */
async function ensureSession(): Promise<void> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const current = new URL(window.location.href);
    const token = current.searchParams.get("token");
    if (!token) return; // 刷新场景：已有 SameSite cookie，后端负责验证
    const res = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) throw new Error("本地会话认证失败，请从 server 新打印的链接重新进入");
    current.searchParams.delete("token");
    const clean = current.pathname + (current.search ? current.search : "") + current.hash;
    window.history.replaceState(null, "", clean);
  })();
  return sessionPromise;
}

export interface InvokeResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export async function invoke(channel: string, payload: Record<string, unknown> = {}): Promise<InvokeResult> {
  try {
    await ensureSession();
    const res = await fetch("/api/invoke", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, payload }),
    });
    return (await res.json()) as InvokeResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SseEvent {
  /**
   * inbox = 收件箱台账落定（{type:"inbox:updated", itemId}），驱动收件箱视图刷新；
   * research = 深调研台账落定或视角级进度（{type:"research:updated", topicId}），驱动选题卡刷新
   */
  kind: "engine" | "chat" | "inbox" | "research";
  data: Record<string, unknown>;
}

type SseListener = (e: SseEvent) => void;

let source: EventSource | null = null;
const listeners = new Set<SseListener>();

/** 订阅引擎/对话事件流。全应用单连接;返回退订函数。 */
export function subscribeEvents(fn: SseListener): () => void {
  listeners.add(fn);
  if (!source) {
    void ensureSession()
      .then(() => {
        if (source || listeners.size === 0) return;
        source = new EventSource("/api/events");
        for (const kind of ["engine", "chat", "inbox", "research"] as const) {
          source.addEventListener(kind, (ev) => {
            let data: Record<string, unknown> = {};
            try {
              data = JSON.parse((ev as MessageEvent).data as string) as Record<string, unknown>;
            } catch {
              /* 坏帧丢弃 */
            }
            for (const l of listeners) l({ kind, data });
          });
        }
      })
      .catch(() => {
        /* invoke 会把认证错误展示给用户；事件流静默等待重载 */
      });
  }
  return () => {
    listeners.delete(fn);
  };
}
