/**
 * 引导与「设置 · 宿主」的浏览器端点（spec §3，O5）。写宿主用户配置是特权动作：
 * 全部只认同源浏览器会话；MCP、bearer（含本机 server-token）一律 403。命令行走 `autocrew connect`，不经这里。
 *
 *   GET  /api/connect             宿主检测（不花额度）+ 是否点过「先不配」
 *   POST /api/connect/probe       {host}  检测登录（Claude 真调一次极小请求）
 *   POST /api/connect/connect     {host}  一键接上
 *   POST /api/connect/disconnect  {host}  断开
 *   POST /api/connect/skip        {skipped}  「先不配」
 */
import type http from "node:http";
import { connectHost, disconnectHost } from "./host-connect/connect.js";
import { detectHosts, parseConnectHost, type ConnectHost } from "./host-connect/detect.js";
import { defaultHostEnv, type HostEnv } from "./host-connect/env.js";
import { readOnboardingSkipped, writeOnboardingSkipped } from "./host-connect/onboarding-state.js";
import { probeHost } from "./host-connect/probe.js";

export interface ConnectRouteDeps {
  authorize: (req: http.IncomingMessage) => "session" | "bearer" | null;
  originAllowed: (req: http.IncomingMessage) => boolean;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  /** 测试注入临时 HOME + 假命令 */
  env?: () => HostEnv;
}

const JSON_TYPE = "application/json; charset=utf-8";
const send = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" }).end(JSON.stringify(body));

export function createConnectHandler(deps: ConnectRouteDeps) {
  const env = deps.env ?? (() => defaultHostEnv());
  // 同一个宿主的接 / 断不并发：双击或两个标签页同时点，第二下直接说「正在处理」
  const busy = new Set<ConnectHost>();
  const session = (req: http.IncomingMessage) => deps.authorize(req) === "session";
  const body = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const raw = await deps.readBody(req);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  };
  const exclusive = async (host: ConnectHost, fn: () => Promise<unknown>) => {
    if (busy.has(host)) return { ok: false, code: "busy", error: "这个宿主正在处理，等这一次做完" };
    busy.add(host);
    try { return await fn(); } finally { busy.delete(host); }
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (p !== "/api/connect" && !p.startsWith("/api/connect/")) return false;
    const isGet = p === "/api/connect" && req.method === "GET";
    if (isGet ? !session(req) : !(session(req) && deps.originAllowed(req) && req.method === "POST")) { res.writeHead(403).end(); return true; }
    try {
      const e = env();
      if (isGet) return send(res, 200, { ok: true, data: { hosts: await detectHosts(e), skipped: readOnboardingSkipped(e.dataDir) } }), true;
      const b = await body(req);
      if (p === "/api/connect/skip") {
        writeOnboardingSkipped(b.skipped !== false, e.dataDir);
        return send(res, 200, { ok: true, data: { skipped: b.skipped !== false } }), true;
      }
      const host = parseConnectHost(typeof b.host === "string" ? b.host : "");
      if (!host) return send(res, 400, { ok: false, error: "不认识这个宿主（只能是 claude / codex / workbuddy）" }), true;
      if (p === "/api/connect/probe") return send(res, 200, await probeHost(host, e)), true;
      if (p === "/api/connect/connect") return send(res, 200, await exclusive(host, () => connectHost(host, e))), true;
      if (p === "/api/connect/disconnect") return send(res, 200, await exclusive(host, () => disconnectHost(host, e))), true;
      send(res, 404, { ok: false, error: "没有这个地址" });
    } catch (err) {
      send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };
}
