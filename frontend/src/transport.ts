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

export interface UploadResult {
  ok: boolean;
  /** 落盘后的绝对路径——直接喂给 `library:add` 入库 */
  path?: string;
  size?: number;
  error?: string;
}

/**
 * 素材直传（素材直传 §2）：字节走独立的 `POST /api/upload`，不塞进 invoke 的 JSON。
 * body 直接给 File，浏览器自己从磁盘流式发；A-roll 是 GB 级的，base64 进 JSON
 * 等于把整条片子搬进内存。
 *
 * 不做进度条：fetch 拿不到上传进度（要换 XHR），为一根进度条引一套请求栈不值得——
 * 调用方把按钮转成「上传中…」即可。
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  try {
    await ensureSession();
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as UploadResult;
    } catch {
      // 非 JSON 响应（如 host 白名单的裸文本 403）：照实把状态码摆出来，不装成成功
      return { ok: false, error: text || `上传失败（HTTP ${res.status}）` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SseEvent {
  /**
   * - inbox：收件箱台账落定（{type:"inbox:updated", itemId}），驱动收件箱视图刷新
   * - research：深调研台账落定或视角级进度（{type:"research:updated", topicId}），驱动选题卡刷新
   * - video:updated：视频状态每次落盘（{contentId}）——订阅方据此重拉 `video:status`
   *   （视频 spec §8.3 四件套之三；事件只报「变了」，不带状态本身，避免两份事实）
   * - chat_delta：总编辑回复的正文增量（{turnId, seq, ev:"delta"|"reset"|"done", text?}）——
   *   只是「正在生成的样子」，事实源仍是 chat:turn 的 invoke 返回（到达后全量覆盖）
   * - chat_followup：总编辑往某段会话里落了一轮**调研回报**（{conversationId, topicId}）——
   *   后台任务回来了,不是用户发起的一轮;右栏据此重载当前会话或提示去会话列表看
   * - reconnect：**客户端合成**事件，不来自服务端。SSE 断线期间的事件已经永久丢失，
   *   重连后订阅方必须无条件重拉一次（同 spec §8.3 之四）
   */
  kind: "engine" | "chat" | "chat_delta" | "chat_followup" | "inbox" | "research" | "video:updated" | "reconnect";
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
        // EventSource 自己会重连,但断线那几秒的事件不会补发。第一次 open 是首连
        // (各视图挂载时本来就拉过一次),之后每次 open 都是重连 → 广播一条合成
        // reconnect,订阅方无条件重拉,免得界面停在断线前那一帧。
        let everOpened = false;
        source.addEventListener("open", () => {
          if (everOpened) for (const l of listeners) l({ kind: "reconnect", data: {} });
          everOpened = true;
        });
        for (const kind of ["engine", "chat", "chat_delta", "chat_followup", "inbox", "research", "video:updated"] as const) {
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
