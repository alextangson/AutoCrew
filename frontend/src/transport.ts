/**
 * Transport（frontend-v2 A 期）——与本地 server 的唯一通道:
 * invoke = POST /api/invoke {channel, payload};SSE = /api/events(engine/chat 双流)。
 * 启动配置来自 /config.js 注入的 window.__AUTOCREW(token/通道表),与 vanilla 同源。
 */

export interface AutocrewConfig {
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
  if (!cfg?.token) {
    throw new Error("启动配置缺失:请从 server 打印的带 token 链接进入(/config.js 未注入)");
  }
  return cfg;
}

export interface InvokeResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export async function invoke(channel: string, payload: Record<string, unknown> = {}): Promise<InvokeResult> {
  try {
    const res = await fetch("/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-autocrew-token": getConfig().token },
      body: JSON.stringify({ channel, payload }),
    });
    return (await res.json()) as InvokeResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SseEvent {
  kind: "engine" | "chat";
  data: Record<string, unknown>;
}

type SseListener = (e: SseEvent) => void;

let source: EventSource | null = null;
const listeners = new Set<SseListener>();

/** 订阅引擎/对话事件流。全应用单连接;返回退订函数。 */
export function subscribeEvents(fn: SseListener): () => void {
  listeners.add(fn);
  if (!source) {
    source = new EventSource(`/api/events?token=${encodeURIComponent(getConfig().token)}`);
    for (const kind of ["engine", "chat"] as const) {
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
  }
  return () => {
    listeners.delete(fn);
  };
}
