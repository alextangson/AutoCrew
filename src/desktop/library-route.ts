/**
 * 「资料放哪」端点（onboarding-connect §7.3）：网页引导和 `autocrew init`（服务在跑时）共用，
 * 在运行中的服务里当场建库（live），不等下次启动。
 * 只认同源浏览器会话或本机 server-token（命令行）；宿主令牌在 /api/* 上早已被 403。
 *
 *   GET  /api/library              现在用哪儿 + 默认路径 + 旧位置有几篇稿
 *   POST /api/library/check {target}            只看不写
 *   POST /api/library/setup {target, legacy?}   建 / 打开；legacy = migrate | keep（O15）
 */
import type http from "node:http";
import { checkLibraryTarget, defaultLibraryPath, legacyData, setupLibrary, type LegacyChoice } from "../storage/library-setup.js";
import { readLibraryLocation } from "../storage/storage-roots.js";

export interface LibraryRouteDeps {
  authorize: (req: http.IncomingMessage) => "session" | "bearer" | null;
  originAllowed: (req: http.IncomingMessage) => boolean;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  /**
   * 当场切库后，把启动时绑死了旧目录的后台服务换到新库（视频服务）。返回还要重启才切过去的部分（人话），
   * 照实放进回执，不报「全部已生效」。
   */
  onActivated?: () => Promise<string[]>;
}

const ACTIVATED = new Set(["created", "opened", "already"]);

const send = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));

export async function libraryStatus(): Promise<Record<string, unknown>> {
  const location = readLibraryLocation();
  return { configured: Boolean(location), root: location?.root ?? null, defaultPath: defaultLibraryPath(), legacyDrafts: (await legacyData()).drafts };
}

export function createLibraryHandler(deps: LibraryRouteDeps) {
  let busy = false;
  const allowed = (req: http.IncomingMessage) => {
    const m = deps.authorize(req);
    return m === "bearer" || (m === "session" && (req.method === "GET" || deps.originAllowed(req)));
  };
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (p !== "/api/library" && !p.startsWith("/api/library/")) return false;
    if (!allowed(req)) { res.writeHead(403).end(); return true; }
    try {
      if (p === "/api/library" && req.method === "GET") return send(res, 200, { ok: true, data: await libraryStatus() }), true;
      if (req.method !== "POST") return send(res, 404, { ok: false, error: "没有这个地址" }), true;
      const raw = await deps.readBody(req);
      const b = (raw ? JSON.parse(raw) : {}) as { target?: unknown; legacy?: unknown };
      if (typeof b.target !== "string" || !b.target.trim()) return send(res, 400, { ok: false, error: "请填资料库路径" }), true;
      if (p === "/api/library/check") return send(res, 200, { ok: true, data: await checkLibraryTarget(b.target) }), true;
      if (p !== "/api/library/setup") return send(res, 404, { ok: false, error: "没有这个地址" }), true;
      if (busy) return send(res, 409, { ok: false, code: "busy", error: "正在建资料库，等这一次做完" }), true;
      const legacy = b.legacy === "migrate" || b.legacy === "keep" ? (b.legacy as LegacyChoice) : undefined;
      busy = true;
      try {
        const r = await setupLibrary({ target: b.target, live: true, ...(legacy ? { legacy } : {}) });
        if (r.status === "refused") return send(res, 400, { ok: false, ...r }), true;
        const pending = ACTIVATED.has(r.status) && deps.onActivated ? await rebind(deps.onActivated) : [];
        return send(res, 200, { ok: true, data: { ...r, ...(pending.length ? { afterRestart: pending } : {}) } }), true;
      } finally { busy = false; }
    } catch (err) {
      send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };
}

/** 换绑失败不吞：资料库已经切好了，失败的那部分照实说要重启 */
async function rebind(fn: () => Promise<string[]>): Promise<string[]> {
  try { return await fn(); }
  catch (err) { return [`后台服务没能换到新资料库（${err instanceof Error ? err.message : String(err)}），重启 AutoCrew 后生效`]; }
}
