/**
 * 浏览器发来的写请求一律算「在跑」（Codex 审第 11 轮 P1）：不再一条条列路由。
 * 每个非 GET 的 /api/* 请求，在处理完（响应关掉）之前都计入忙碌；更新锁在手时直接回「AutoCrew 正在更新，稍后再试」。
 * 例外：更新自己的路由（/api/update/*）和登录换会话（/api/session）——更新流程要用它们。
 * 请求返回之后还在后台跑的活（写稿、生图…）照旧在各自的入口登记，这里只管请求本身。
 */
import type http from "node:http";
import { beginWork } from "../modules/update/active-work.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function guardedMutation(method: string | undefined, pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  if (READ_METHODS.has((method ?? "GET").toUpperCase())) return false;
  return !(pathname === "/api/session" || pathname === "/api/update" || pathname.startsWith("/api/update/"));
}

/** true = 放行（已登记，响应关掉时自动释放）；false = 正在更新，已经回了 503 */
export function admitMutation(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (!guardedMutation(req.method, pathname)) return true;
  const work = beginWork(`${req.method} ${pathname}`);
  if (!work.ok) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60" })
      .end(JSON.stringify({ ok: false, code: "updating", error: work.error }));
    return false;
  }
  res.once("close", work.end);
  return true;
}
