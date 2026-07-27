/**
 * AutoCrew 本地 server（PRD-v4 §11）——引擎跑在用户本机,前端搬进浏览器 tab。
 * 取代 desktop/main.ts 的 Electron 主进程:复用同一套 buildIpcHandlers,
 * IPC 通道 → HTTP 端点,event-hub broadcast → SSE。零新依赖(仅 Node 原生)。
 *
 * 红线(PRD-v4 §11):只绑 127.0.0.1 + 启动 token + Host 白名单(防 DNS-rebinding)。
 * server 永远本地,绝不上云——上云=护城河消失。
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
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
import { LocalSessionAuth } from "../src/desktop/server-auth.js";
import { ApprovalGate } from "../src/desktop/approval-gate.js";
import { reconcileOrphanDrafts } from "../src/desktop/orphan-reconcile.js";
import { expireStaleTopics } from "../src/desktop/topic-expiry.js";
import { startInboxRuntime } from "../src/desktop/inbox-runtime.js";
import { startResearchRuntime } from "../src/desktop/research-runtime.js";
import { serveResearchAsset } from "../src/desktop/research-asset-route.js";
import { setVideoService } from "../src/desktop/video-handlers.js";
import { createVideoMediaHandler, VIDEO_MEDIA_PREFIX } from "../src/desktop/video-media.js";
import { createVideoService, type VideoService } from "../src/modules/video/service.js";
import { initEventHub, emitEngineEvent, type EngineEventRole } from "../src/desktop/event-hub.js";
import { refreshTopicRadarIfStale } from "../src/modules/radar/topic-radar.js";
import { intakeRadarTopics } from "../src/modules/radar/radar-intake.js";
import { startManagedCampaignHost } from "../src/modules/campaign/managed-host.js";
import { handleMcpRequest } from "../mcp/server.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.AUTOCREW_PORT) || 4317;
// 持久 token 只留给显式 Authorization CLI；浏览器只看到本进程一次性启动 token。
const TOKEN = resolveServerToken();
const BROWSER_BOOT_TOKEN = randomBytes(32).toString("hex");
const AUTH = new LocalSessionAuth(
  BROWSER_BOOT_TOKEN,
  new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]),
  undefined,
  undefined,
  TOKEN,
);
const APPROVALS = new ApprovalGate();
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
function authorize(req: http.IncomingMessage): "session" | "bearer" | null {
  return AUTH.authenticate({
    authorization: req.headers.authorization,
    cookie: req.headers.cookie,
  });
}

function browserWriteAllowed(req: http.IncomingMessage, method: "session" | "bearer"): boolean {
  return method === "bearer" || AUTH.originAllowed(req.headers.origin);
}

function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
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
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      body += c;
      if (body.length > 8 * 1024 * 1024) {
        tooLarge = true;
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ── 视频线接线（视频 spec §8）────────────────────────────────────────────────
/** 当前工作区 dataDir;注册表异常一律回退默认工作区(与 /api/asset、/mcp 同款) */
async function activeDataDir(): Promise<string> {
  try {
    return (await activeWorkspaceDataDir()) ?? getDataDir();
  } catch {
    return getDataDir();
  }
}
const videoMedia = createVideoMediaHandler({
  resolveDataDir: activeDataDir,
  authorize: (req) => authorize(req) !== null,
});

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  if (!hostAllowed(req)) { res.writeHead(403).end("bad host"); return; }
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (p === "/favicon.ico") { res.writeHead(204).end(); return; }

  // React 前端:/ 为主,/v2 为书签兼容别名(D 期清场后同一份 dist)
  if (p === "/v2" || p.startsWith("/v2/")) {
    await serveApp(res, p.replace(/^\/v2\/?/, ""));
    return;
  }

  // 启动配置只含公开契约。长期 token 绝不进入脚本响应，避免第三方页面
  // 通过 <script src="http://127.0.0.1:4317/config.js"> 窃取。
  if (p === "/config.js") {
    res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
    // token:"" 暂留一个兼容字段；它不是凭证，旧前端拼到资源 URL 也不会获权。
    res.end(`window.__AUTOCREW = ${JSON.stringify({ token: "", channels: [...IPC_CHANNELS], methodMap: Object.fromEntries(IPC_CHANNELS.map((c) => [chToMethod(c), c])) })};`);
    return;
  }

  // MCP Streamable HTTP 基础端点：与 stdio 共用同一 JSON-RPC 处理器与 Capability Registry。
  // 本地版沿用现有 Bearer/session 鉴权；商业远程部署可在此前置 OAuth 资源服务器。
  if (p === "/mcp") {
    const authMethod = authorize(req);
    if (!authMethod) {
      res.writeHead(401, { "Content-Type": MIME[".json"], "WWW-Authenticate": "Bearer" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST, GET", "Cache-Control": "no-store" }).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, GET" }).end();
      return;
    }
    if (!browserWriteAllowed(req, authMethod)) {
      res.writeHead(403, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ error: "bad origin" }));
      return;
    }
    if (!(req.headers["content-type"] || "").includes("application/json")) {
      res.writeHead(415).end("application/json required");
      return;
    }
    let request: Record<string, unknown>;
    try { request = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end("bad json"); return; }
    let mcpDataDir: string;
    try { mcpDataDir = (await activeWorkspaceDataDir()) ?? getDataDir(); } catch { mcpDataDir = getDataDir(); }
    const response = await handleMcpRequest(request, {
      principal: { subject: "local-user", plan: "local" },
    }, mcpDataDir);
    if (!response) {
      res.writeHead(202, { "Cache-Control": "no-store" }).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[".json"],
      "Cache-Control": "no-store",
      "MCP-Protocol-Version": "2025-11-25",
    });
    res.end(JSON.stringify(response));
    return;
  }

  // 首次打开带 ?token=… 的本地 URL 后，前端把 boot token 换成短时 HttpOnly
  // SameSite session cookie，再立即从地址栏移除 token。
  if (p === "/api/session" && req.method === "POST") {
    if (!AUTH.originAllowed(req.headers.origin)) { res.writeHead(403).end(JSON.stringify({ ok: false, error: "bad origin" })); return; }
    if (!(req.headers["content-type"] || "").includes("application/json")) {
      res.writeHead(415).end(JSON.stringify({ ok: false, error: "application/json required" }));
      return;
    }
    let parsed: { token?: string };
    try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end(JSON.stringify({ ok: false, error: "bad json" })); return; }
    const issued = AUTH.issueSession(typeof parsed.token === "string" ? parsed.token : "");
    if (!issued) { res.writeHead(403).end(JSON.stringify({ ok: false, error: "bad token" })); return; }
    res.writeHead(200, {
      "Content-Type": MIME[".json"],
      "Cache-Control": "no-store",
      "Set-Cookie": AUTH.cookieHeader(issued.sessionId),
    });
    res.end(JSON.stringify({ ok: true, expiresAt: issued.expiresAt }));
    return;
  }

  // 生成资源(封面/正文配图)只读流式端点:invoke 走 JSON,图片字节走这里。
  // 白名单校验 content_id/文件名/kind,路径钉死在对应 assets 子目录下;
  // 文件名带修订号(-rN)所以 immutable 缓存安全。
  if (p === "/api/asset") {
    if (!authorize(req)) { res.writeHead(403).end(); return; }
    const contentId = url.searchParams.get("content_id") || "";
    const name = url.searchParams.get("name") || "";
    const kind = url.searchParams.get("kind") || "cover";
    const ext = path.extname(name).toLowerCase();
    if (
      !/^content-\d+-[a-z0-9]+$/.test(contentId) ||
      !/^[A-Za-z0-9._-]+$/.test(name) ||
      name.includes("..") ||
      !["cover", "article"].includes(kind) ||
      ![".png", ".jpg", ".jpeg", ".webp"].includes(ext)
    ) {
      res.writeHead(400).end("bad params");
      return;
    }
    let base: string;
    try { base = (await activeWorkspaceDataDir()) ?? getDataDir(); } catch { base = getDataDir(); }
    const assetFolder = kind === "article" ? "article-images" : "covers";
    const file = path.join(base, "contents", contentId, "assets", assetFolder, name);
    if (!file.startsWith(path.join(base, "contents"))) { res.writeHead(403).end(); return; }
    try { await fs.access(file); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" });
    createReadStream(file).pipe(res);
    return;
  }

  // 研究素材只读端点(深调研 §7):同 /api/asset 的鉴权纪律,但路径一律经存储层的越界闸
  // (index.jsonl 是可篡改文本,不在这里拼路径)。文件名是内容 hash → immutable 缓存安全。
  if (p === "/api/research-asset") {
    let base: string;
    try { base = (await activeWorkspaceDataDir()) ?? getDataDir(); } catch { base = getDataDir(); }
    const served = await serveResearchAsset({
      assetId: url.searchParams.get("asset_id") || "",
      authorized: Boolean(authorize(req)),
      dataDir: base,
    });
    if (!served.ok) { res.writeHead(served.status).end(served.error); return; }
    res.writeHead(200, { "Content-Type": served.contentType, "Cache-Control": "public, max-age=31536000, immutable" });
    createReadStream(served.file).pipe(res);
    return;
  }
  // 成片播放端点(视频 spec §6.4):审片视图的 <video> 播不了 file://,没有它整条视频线
  // 到 review 就断。鉴权/路径白名单/Range 全在 video-media.ts(可测),这里只接线。
  if (p.startsWith(VIDEO_MEDIA_PREFIX) && (await videoMedia(req, res, p))) return;

  // SSE:引擎事件 + chat 进度实时流
  if (p === "/api/events") {
    if (!authorize(req)) { res.writeHead(403).end(); return; }
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
    const authMethod = authorize(req);
    if (!authMethod) { res.writeHead(403).end(JSON.stringify({ ok: false, error: "not authenticated" })); return; }
    if (!browserWriteAllowed(req, authMethod)) { res.writeHead(403).end(JSON.stringify({ ok: false, error: "bad origin" })); return; }
    if (!(req.headers["content-type"] || "").includes("application/json")) {
      res.writeHead(415).end(JSON.stringify({ ok: false, error: "application/json required" }));
      return;
    }
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
      requestApproval: (binding) => APPROVALS.issue(binding),
      consumeApproval: (token, binding) => APPROVALS.consume(token, binding),
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
let stopCampaignHost: (() => void) | undefined;
let videoService: VideoService | null = null;
server.on("close", () => {
  stopCampaignHost?.();
  // 视频 runner 会拿着 ffmpeg/remotion 子进程,停机要给它机会收尾(job lease 也在这层解)
  const running = videoService;
  videoService = null;
  setVideoService(null);
  void running?.shutdown().catch((err) => console.error("[video] 停机失败:", err instanceof Error ? err.message : err));
});

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

// 灵感收件箱(spec §2.1):TG 长轮询 worker 是进程内全局单例。未配置/工作区缺失
// 只登记可见状态、不启动;失败不阻断 server 启动(状态走 doctor 与设置页)。
// onInboxEvent → SSE `inbox` 流:worker 每次写完台账推一条 {type,itemId},收件箱视图据此刷新。
void startInboxRuntime({ onInboxEvent: (e) => broadcast("inbox", e) })
  .then((s) => console.log(`  [inbox] 收件箱 worker:${s.state}${s.detail ? ` —— ${s.detail}` : ""}`))
  .catch((err) => console.error("[inbox] 收件箱启动失败:", err instanceof Error ? err.message : err));

// 深调研(deep-research spec §2):串行 runner 是进程内单例,启动回收中断的 job 并重排。
// onResearchEvent 同时接 job 级落定与视角级进度 → SSE `research` 流,选题卡据此刷新。
void startResearchRuntime({ onResearchEvent: (e) => broadcast("research", e) })
  .then((s) => console.log(`  [research] 深调研 runner:${s.state}${s.reclaimed ? ` —— 回收 ${s.reclaimed} 条中断任务` : ""}`))
  .catch((err) => console.error("[research] 深调研启动失败:", err instanceof Error ? err.message : err));
// 视频生产线(spec §8.3 SSE 四件套之一):状态每次落盘 → broadcast `video:updated`,
// 订阅方收到后重拉 video:status。启动回收(心跳过期的 running 重排)在 service 内部,
// 这里只管建与停。服务跟随**启动时**的工作区——切工作区后要重启(handler 会照实拒绝)。
try {
  const videoDataDir = await activeDataDir();
  videoService = createVideoService({
    dataDir: videoDataDir,
    onEvent: (e) => broadcast(e.type, { contentId: e.contentId }),
    onError: (msg) => console.error(`[video] ${msg}`),
  });
  setVideoService(videoService, videoDataDir);
} catch (err) {
  console.error("[video] 视频服务启动失败:", err instanceof Error ? err.message : err);
}

server.listen(PORT, HOST, () => {
  console.log("\n  AutoCrew 编辑部已启动 —— 在浏览器打开:\n");
  console.log(`  \x1b[1mhttp://${HOST}:${PORT}/?token=${BROWSER_BOOT_TOKEN}\x1b[0m\n`);
  console.log("  (链接中的启动 token 仅本进程首次打开有效；认证后会从地址栏移除)\n");

  stopCampaignHost = startManagedCampaignHost({
    resolveDataDir: async () => activeWorkspaceDataDir(),
    onEvent: (event, dataDir) => {
      void emitEngineEvent(
        {
          role: "system",
          kind: event.phase === "cycle_failed" ? "run_failed" : "work",
          label: event.label,
        },
        dataDir,
      ).catch(() => {});
    },
  });

  // 选题雷达:启动 fire-and-forget 刷新 → 命中定位的候选自动入灵感库(IA v4.2 §A1)。
  // TTL 门:缓存新鲜就跳过——X 等付费源按请求计费,每次重启无条件全量扫是白烧钱。
  void refreshTopicRadarIfStale()
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
