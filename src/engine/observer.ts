/**
 * 环回观察器 — pi-ai 迁移后的字节级传输层（spike A3 定型，spec §0）。
 *
 * SDK → http://127.0.0.1:<port>/t/<token>/<path> → 观察器 →（fetchImpl）→ 上游。
 * 职责只有传输与计时：字节级空闲看门狗（含首字节等待，任何字节续命）。
 * 不解析、不落盘 —— run-log 在 loop 层做。
 *
 * per-call 隔离：每次调用 register() 领 token，携带自己的 upstreamBase/fetchImpl/idleMs；
 * 并发调用互不串扰，无任何全局改写（globalThis.fetch 不动）。
 * fetchImpl 即旧 loop 的测试注入口：测试把 fake 喂到上游腿，生产默认 globalThis.fetch。
 * 进程内单例 server，lazy 启动，unref 不阻退出。
 */
import http from "node:http";
import { isRetryable } from "../utils/retry.js";

export interface ObserverRoute {
  upstreamBase: string;
  fetchImpl: typeof fetch;
  /** 空闲看门狗窗口（ms）：窗口内无任何字节 → 中止本次交换 */
  idleMs: number;
}

interface ObserverHandle {
  /** SDK 用的 baseUrl（含 token 路径段） */
  baseUrl: string;
  release: () => void;
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length",
]);

const routes = new Map<string, ObserverRoute>();
let server: http.Server | undefined;
let port = 0;
let starting: Promise<number> | undefined;
let tokenSeq = 0;

function handleExchange(req: http.IncomingMessage, res: http.ServerResponse): void {
  const m = /^\/t\/([a-zA-Z0-9-]+)(\/.*)$/.exec(req.url ?? "");
  const route = m ? routes.get(m[1]) : undefined;
  if (!m || !route) {
    res.writeHead(404).end("observer: unknown token");
    return;
  }
  const rest = m[2];

  // 请求体缓冲：引擎请求皆为 JSON，体积小；缓冲换取 fetchImpl 兼容性（旧测试 fake 均收字符串体）
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void forward(route, req, rest, Buffer.concat(chunks), res);
  });
}

async function forward(
  route: ObserverRoute,
  req: http.IncomingMessage,
  rest: string,
  body: Buffer,
  res: http.ServerResponse,
): Promise<void> {
  const ctrl = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      ctrl.abort(new Error("engine loop: idle timeout（relay 无响应）"));
      res.destroy(new Error("observer idle timeout"));
    }, route.idleMs);
  };
  const disarm = () => {
    if (idleTimer) clearTimeout(idleTimer);
  };

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  }

  armIdle(); // 首字节等待也在窗口内
  try {
    const upstream = await route.fetchImpl(`${route.upstreamBase}${rest}`, {
      method: req.method,
      headers,
      body: body.length > 0 ? new Uint8Array(body) : undefined,
      signal: ctrl.signal,
    });
    armIdle(); // 响应头到达算活动
    const outHeaders: Record<string, string> = {};
    upstream.headers?.forEach?.((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
    });
    // 中转抽风归一化:流式请求收到非 SSE 的 200(HTML/error-shaped JSON)= 垃圾响应。
    // 旧引擎在解析层报 malformed 并 fail-fast;SDK 会吞掉 body 里的 provider 信息 ——
    // 这里改写为 400 透传原 body:SDK/pi-ai 的 error-body 提取器把 provider 错误带回
    // 错误消息,且 400 不进重试通道(与旧 fail-fast 契约一致)。
    const contentType = upstream.headers?.get?.("content-type") ?? "";
    if (upstream.status === 200 && !contentType.includes("event-stream")) {
      const junk = await upstream.text();
      res.writeHead(400, { "content-type": contentType || "text/plain" });
      res.end(junk);
      return;
    }
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle(); // 收到字节 → 续命
        res.write(value);
      }
    } else {
      const text = await upstream.text?.();
      if (text) res.write(text);
    }
    res.end();
  } catch (err) {
    // 上游 fetchImpl 抛错（响应头未发出）：错误消息与可重试性都要穿过 socket 边界 ——
    // 用 isRetryable 保持旧 loop 的消息模式判定（"terminated"→重试,任意业务错误→fail-fast），
    // 消息经 JSON error body 透传，SDK/pi-ai 的 error-body 提取器带回错误文案。
    // 响应头已发出（看门狗中止/读流失败）：只能掐断连接，SDK 侧转为连接错误（可重试）。
    if (!res.headersSent && !res.destroyed) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(isRetryable(err) ? 502 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: msg } }));
    } else if (!res.destroyed) {
      res.destroy(new Error("observer upstream failure"));
    }
  } finally {
    disarm();
  }
}

function ensureServer(): Promise<number> {
  if (port > 0) return Promise.resolve(port);
  if (starting) return starting;
  starting = new Promise((resolve) => {
    server = http.createServer(handleExchange);
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      port = (server!.address() as { port: number }).port;
      resolve(port);
    });
  });
  return starting;
}

/** 注册一次模型调用的传输路由，返回 SDK 用的 baseUrl；调用结束必须 release()。 */
export async function registerExchange(route: ObserverRoute): Promise<ObserverHandle> {
  const p = await ensureServer();
  const token = `x${++tokenSeq}`;
  routes.set(token, route);
  return {
    baseUrl: `http://127.0.0.1:${p}/t/${token}`,
    release: () => {
      routes.delete(token);
    },
  };
}

/** 测试收尾用：关掉单例 server（生产不调用——unref 已保证进程可退）。 */
export async function shutdownObserver(): Promise<void> {
  const s = server;
  server = undefined;
  starting = undefined;
  port = 0;
  routes.clear();
  if (s) await new Promise<void>((r) => s.close(() => r()));
}
