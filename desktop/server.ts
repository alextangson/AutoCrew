/**
 * AutoCrew 本地 server（PRD-v4 §11）——引擎跑在用户本机,前端搬进浏览器 tab。
 * 取代 desktop/main.ts 的 Electron 主进程:复用同一套 buildIpcHandlers,
 * IPC 通道 → HTTP 端点,event-hub broadcast → SSE。零新依赖(仅 Node 原生)。
 *
 * 红线(PRD-v4 §11):只绑 127.0.0.1 + 启动 token + Host 白名单(防 DNS-rebinding)。
 * server 永远本地,绝不上云——上云=护城河消失。
 */
import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_CHANNELS, chToMethod } from "../src/desktop/channels.js";
import { getDataDir } from "../src/storage/local-store.js";
import { buildIpcHandlers, type IpcHandlerContext } from "../src/desktop/ipc.js";
import { sanitizePayload } from "../src/desktop/ipc-guard.js";
import { validatePayload } from "../src/desktop/channel-contracts.js";
import { activeWorkspaceDataDir } from "../src/desktop/workspace-store.js";
import { resolveServerToken } from "../src/desktop/server-token.js";
import { reconcileOrphanDrafts } from "../src/desktop/orphan-reconcile.js";
import { expireStaleTopics } from "../src/desktop/topic-expiry.js";
import { initEventHub, emitEngineEvent, type EngineEventRole } from "../src/desktop/event-hub.js";
import { refreshTopicRadar } from "../src/modules/radar/topic-radar.js";
import { intakeRadarTopics } from "../src/modules/radar/radar-intake.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.AUTOCREW_PORT) || 4317;
// 持久化 token（两台协作:主机常开、笔记本远程连——重启不变,远端书签一劳永逸）
const TOKEN = resolveServerToken();
// D 期已清场(frontend-v2 契约):React 是唯一前端,/ 与 /v2(书签兼容别名)都服务它
const FRONTEND_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "dist");
const CHANNELS = new Set<string>(IPC_CHANNELS);

const handlers = buildIpcHandlers();

// ── SSE 广播 ──────────────────────────────────────────────────────────────────
const sseClients = new Set<http.ServerResponse>();
function broadcast(event: string, data: unknown): void {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(chunk); } catch { /* 客户端已断 */ }
  }
}
initEventHub((e) => broadcast("engine", e));

// ── 安全 ──────────────────────────────────────────────────────────────────────
function hostAllowed(req: http.IncomingMessage): boolean {
  const host = (req.headers.host || "").split(":")[0];
  return host === "127.0.0.1" || host === "localhost";
}
function tokenOk(req: http.IncomingMessage, url: URL): boolean {
  const header = req.headers["x-autocrew-token"];
  const q = url.searchParams.get("token");
  return header === TOKEN || q === TOKEN;
}

// ── 静态资源 ──────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
};
/** React 前端静态托管:SPA 回退到 index.html;dist 缺失给出构建指引而非裸 404 */
async function serveApp(res: http.ServerResponse, rel: string): Promise<void> {
  const clean = rel.replace(/\.\.+/g, "").replace(/^\/+/, "");
  let file = path.join(FRONTEND_DIST, clean || "index.html");
  if (!file.startsWith(FRONTEND_DIST)) { res.writeHead(403).end("forbidden"); return; }
  try {
    await fs.access(file);
  } catch {
    file = path.join(FRONTEND_DIST, "index.html");
    try {
      await fs.access(file);
    } catch {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
        .end("前端未构建：先执行 npm run fe:build 再刷新");
      return;
    }
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req)) { res.writeHead(403).end("bad host"); return; }
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (p === "/favicon.ico") { res.writeHead(204).end(); return; }

  // React 前端:/ 为主,/v2 为书签兼容别名(D 期清场后同一份 dist)
  if (p === "/v2" || p.startsWith("/v2/")) {
    await serveApp(res, p.replace(/^\/v2\/?/, ""));
    return;
  }

  // 启动配置:token + 通道 → 前端 transport。同源、CSP 干净。
  if (p === "/config.js") {
    res.writeHead(200, { "Content-Type": MIME[".js"] });
    res.end(`window.__AUTOCREW = ${JSON.stringify({ token: TOKEN, channels: [...IPC_CHANNELS], methodMap: Object.fromEntries(IPC_CHANNELS.map((c) => [chToMethod(c), c])) })};`);
    return;
  }

  // 生成资源(封面等)只读流式端点:invoke 走 JSON,图片字节走这里。
  // 白名单校验 content_id/文件名,路径钉死在 contents/<id>/assets/covers 下;
  // 文件名带修订号(-rN)所以 immutable 缓存安全。
  if (p === "/api/asset") {
    if (!tokenOk(req, url)) { res.writeHead(403).end(); return; }
    const contentId = url.searchParams.get("content_id") || "";
    const name = url.searchParams.get("name") || "";
    const ext = path.extname(name).toLowerCase();
    if (
      !/^content-\d+-[a-z0-9]+$/.test(contentId) ||
      !/^[A-Za-z0-9._-]+$/.test(name) ||
      name.includes("..") ||
      ![".png", ".jpg", ".jpeg", ".webp"].includes(ext)
    ) {
      res.writeHead(400).end("bad params");
      return;
    }
    let base: string;
    try { base = (await activeWorkspaceDataDir()) ?? getDataDir(); } catch { base = getDataDir(); }
    const file = path.join(base, "contents", contentId, "assets", "covers", name);
    if (!file.startsWith(path.join(base, "contents"))) { res.writeHead(403).end(); return; }
    try { await fs.access(file); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" });
    createReadStream(file).pipe(res);
    return;
  }

  // SSE:引擎事件 + chat 进度实时流
  if (p === "/api/events") {
    if (!tokenOk(req, url)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("event: ready\ndata: {}\n\n");
    sseClients.add(res);
    // 防呆 P3:心跳帧——长生成期间无事件,空闲连接可能被浏览器/中间层静默掐断
    const heartbeat = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { /* 已断,close 会清理 */ }
    }, 30_000);
    req.on("close", () => { clearInterval(heartbeat); sseClients.delete(res); });
    return;
  }

  // 统一调用端点:{channel, payload} → handler
  if (p === "/api/invoke" && req.method === "POST") {
    if (!tokenOk(req, url)) { res.writeHead(403).end(JSON.stringify({ ok: false, error: "bad token" })); return; }
    let parsed: { channel?: string; payload?: Record<string, unknown> };
    try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end(JSON.stringify({ ok: false, error: "bad json" })); return; }
    const channel = parsed.channel;
    if (!channel || !CHANNELS.has(channel)) { res.writeHead(404).end(JSON.stringify({ ok: false, error: `unknown channel: ${channel}` })); return; }
    const clean = sanitizePayload(parsed.payload ?? {}) as Record<string, unknown>;
    // 契约校验（channel-contracts 是通道形状的单一事实源）:必填缺失在边界拒,不进 handler
    const contractError = validatePayload(channel, clean);
    if (contractError) { res.writeHead(200, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ ok: false, error: contractError })); return; }
    // 多工作区:active 的 dataDir 由 server 端从注册表解析注入（sanitize 已剥前端伪造,此处注入可信）
    try {
      const wsDir = await activeWorkspaceDataDir();
      if (wsDir) clean._dataDir = wsDir;
    } catch { /* 注册表异常 → 默认工作区,不阻断 */ }
    const ctx: IpcHandlerContext = {
      onProgress: (e) => {
        broadcast("chat", e);
        const pe = e as { phase?: string; role?: string | null; label?: string; runId?: string };
        if (pe.phase === "start") {
          void emitEngineEvent({
            role: (pe.role as EngineEventRole) || "system",
            kind: "work",
            label: pe.label || "工作中",
            ...(pe.runId ? { runId: pe.runId } : {}),
          });
        }
      },
    };
    try {
      const result = await handlers[channel as (typeof IPC_CHANNELS)[number]](clean, ctx);
      res.writeHead(200, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(200, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  await serveApp(res, p);
});

// 防呆 P3:写长文是分钟级任务——本地单用户 server 不许因超时掐断慢请求
server.requestTimeout = 0;
server.timeout = 0;

// 先清孤儿再开门(SESSION-8 §3.1):上次崩溃遗留的「生成中」占位稿在接收任何
// 新请求前标记为中断——listen 前执行,与本进程的新生成零竞态;失败不阻断启动。
try {
  const reconciled = await reconcileOrphanDrafts();
  if (reconciled.total > 0) {
    console.log(`  [reconcile] ${reconciled.total} 篇中断的「生成中」稿已标记,看板点开可重试`);
  }
} catch (err) {
  console.error("[reconcile] 孤儿稿清理失败:", err instanceof Error ? err.message : err);
}

// 灵感库过期清理(V5.4c 创始人裁决):3 天未选用自动入回收站;有稿件血缘的永不清理
try {
  const swept = await expireStaleTopics();
  if (swept.total > 0) {
    console.log(`  [expiry] ${swept.total} 条超过 3 天未选用的灵感已移入回收站(可恢复)`);
  }
} catch (err) {
  console.error("[expiry] 灵感库清理失败:", err instanceof Error ? err.message : err);
}

server.listen(PORT, HOST, () => {
  console.log("\n  AutoCrew 编辑部已启动 —— 在浏览器打开:\n");
  console.log(`  \x1b[1mhttp://${HOST}:${PORT}/?token=${TOKEN}\x1b[0m\n`);
  console.log("  (token 已固定,重启不变 —— 收藏一次即可;两台协作见 docs)\n");

  // 选题雷达:启动 fire-and-forget 刷新 → 命中定位的候选自动入灵感库(IA v4.2 §A1)。
  // 此前该启动链只活在弃用的 Electron 壳(main.ts:112),server 化时遗漏,此处收编。
  void refreshTopicRadar()
    .then(async (r) => {
      if (r.failedSources.length > 0) console.warn("[topic-radar] 部分源失败:", r.failedSources.join(", "));
      const intake = await intakeRadarTopics();
      if (intake.saved.length > 0) {
        void emitEngineEvent({
          role: "scout",
          kind: "work",
          label: `雷达入库 ${intake.saved.length} 条灵感:${intake.saved.map((t) => t.title).join("｜").slice(0, 80)}`,
        });
      }
    })
    .catch((err) => {
      console.error("[topic-radar] 启动刷新失败:", err instanceof Error ? err.message : err);
    });
});
