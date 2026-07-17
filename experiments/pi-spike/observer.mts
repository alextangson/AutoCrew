/**
 * A3 原型：进程内环回反向观察器。
 * SDK → http://127.0.0.1:<port>/t/<token>/<path> → 观察器 →（明文转发）→ 真实上游。
 *
 * 职责：字节级空闲看门狗（上游响应含首字节等待，任何字节续命）+ 每次交换的
 * 字节时间线记录。per-call 隔离靠 token 路径段；无任何全局改写。
 * 观察器只做传输与计时，不解析、不落盘 —— run-log 在 onPayload/结果层做。
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface ObserverEvent {
  token: string;
  kind: "request_start" | "upstream_headers" | "bytes" | "idle_kill" | "done" | "upstream_error";
  bytes?: number;
  at: number;
}

export interface Observer {
  port: number;
  baseUrlFor: (token: string) => string;
  events: ObserverEvent[];
  close: () => Promise<void>;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host"]);

export function startObserver(opts: { upstreamBase: string; idleMs: number }): Promise<Observer> {
  const upstream = new URL(opts.upstreamBase);
  const transport = upstream.protocol === "https:" ? https : http;
  const events: ObserverEvent[] = [];

  const server = http.createServer((req, res) => {
    const m = /^\/t\/([a-zA-Z0-9-]+)(\/.*)$/.exec(req.url ?? "");
    if (!m) {
      res.writeHead(400).end("observer: bad path");
      return;
    }
    const [, token, rest] = m;
    events.push({ token, kind: "request_start", at: Date.now() });

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
    }
    headers.host = upstream.host;

    const upPath = (upstream.pathname === "/" ? "" : upstream.pathname) + rest;
    const upReq = transport.request(
      { host: upstream.hostname, port: upstream.port || (upstream.protocol === "https:" ? 443 : 80), path: upPath, method: req.method, headers },
      (upRes) => {
        touch();
        events.push({ token, kind: "upstream_headers", at: Date.now() });
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.on("data", (chunk: Buffer) => {
          touch();
          events.push({ token, kind: "bytes", bytes: chunk.length, at: Date.now() });
          res.write(chunk);
        });
        upRes.on("end", () => {
          finish();
          events.push({ token, kind: "done", at: Date.now() });
          res.end();
        });
        upRes.on("error", () => {
          finish();
          res.destroy();
        });
      },
    );

    // 看门狗：首字节等待也在窗口内（发出请求即开表）
    let lastActivity = Date.now();
    const touch = () => (lastActivity = Date.now());
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > opts.idleMs) {
        events.push({ token, kind: "idle_kill", at: Date.now() });
        finish();
        upReq.destroy(new Error("observer idle timeout"));
        res.destroy(new Error("observer idle timeout"));
      }
    }, Math.min(500, Math.max(50, opts.idleMs / 4)));
    const finish = () => clearInterval(watchdog);

    upReq.on("error", (err) => {
      finish();
      if (!res.headersSent) res.writeHead(502);
      events.push({ token, kind: "upstream_error", at: Date.now() });
      res.destroy(err);
    });
    req.on("data", () => touch());
    req.pipe(upReq);
    res.on("close", finish);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        baseUrlFor: (token: string) => `http://127.0.0.1:${port}/t/${token}`,
        events,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
