/**
 * 数据页封面端点（数据页规格 §I.56）：
 *   GET  /api/data/cover-file?name=…     读图；文件名走白名单，路径钉死在 <dataDir>/data-covers/ 下（同 /api/asset 的纪律）
 *   POST /api/data/cover?key=…           手动补 / 替换；请求体就是图片字节，≤10MB，只收 png / jpg / webp（看文件头）
 *   POST /api/data/cover-remove          { key } 移除手动补的封面（确认在前端）
 * 写操作只给浏览器会话 + 同源。
 */
import type http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import {
  COVER_FILE_RE, COVER_MIME, MAX_COVER_BYTES, coverDir, removeManualCover, saveManualCover, type CoverExt,
} from "../modules/flywheel/data-covers.js";

export interface CoverRouteDeps {
  authorize: (req: http.IncomingMessage) => "session" | "bearer" | null;
  originAllowed: (req: http.IncomingMessage) => boolean;
  resolveDataDir: () => Promise<string>;
  readBody: (req: http.IncomingMessage) => Promise<string>;
}

const KEY_RE = /^[cw]:.{1,400}$/s;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

/** 读二进制请求体；超过上限立刻停，不把大文件读进内存 */
export function readBytes(req: http.IncomingMessage, limit = MAX_COVER_BYTES): Promise<Uint8Array | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; resolve("too_large"); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) resolve(new Uint8Array(Buffer.concat(chunks))); });
    req.on("error", reject);
  });
}

async function serveFile(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: CoverRouteDeps) {
  if (!deps.authorize(req)) { res.writeHead(403).end(); return; }
  const name = url.searchParams.get("name") ?? "";
  if (!COVER_FILE_RE.test(name)) { res.writeHead(400).end("bad params"); return; }
  const dir = coverDir(await deps.resolveDataDir());
  const file = path.join(dir, name);
  if (path.dirname(file) !== dir) { res.writeHead(400).end("bad params"); return; }
  try { await fs.access(file); } catch { res.writeHead(404).end(); return; }
  const ext = path.extname(name).slice(1) as CoverExt;
  res.writeHead(200, { "Content-Type": COVER_MIME[ext], "Cache-Control": "private, no-cache" });
  createReadStream(file).pipe(res);
}

async function upload(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: CoverRouteDeps) {
  const key = url.searchParams.get("key") ?? "";
  if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: "缺少作品标识" });
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_COVER_BYTES) { req.resume(); return json(res, 413, { ok: false, error: "图片超过 10MB，换一张小一点的" }); }
  const bytes = await readBytes(req);
  if (bytes === "too_large") return json(res, 413, { ok: false, error: "图片超过 10MB，换一张小一点的" });
  try { json(res, 200, { ok: true, data: { file: await saveManualCover(await deps.resolveDataDir(), key, bytes) } }); }
  catch (e) { json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
}

async function remove(req: http.IncomingMessage, res: http.ServerResponse, deps: CoverRouteDeps) {
  try {
    const body = JSON.parse(await deps.readBody(req)) as { key?: unknown };
    const key = typeof body.key === "string" ? body.key : "";
    if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: "缺少作品标识" });
    json(res, 200, { ok: true, data: { removed: await removeManualCover(await deps.resolveDataDir(), key) } });
  } catch (e) { json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
}

export function createCoverHandler(deps: CoverRouteDeps) {
  const writeAllowed = (req: http.IncomingMessage) => deps.authorize(req) === "session" && deps.originAllowed(req);
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (p === "/api/data/cover-file" && req.method === "GET") { await serveFile(req, res, url, deps); return true; }
    if ((p === "/api/data/cover" || p === "/api/data/cover-remove") && req.method === "POST") {
      if (!writeAllowed(req)) { req.resume(); res.writeHead(403).end(); return true; }
      if (p === "/api/data/cover") await upload(req, res, url, deps);
      else await remove(req, res, deps);
      return true;
    }
    return false;
  };
}
