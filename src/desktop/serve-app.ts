/**
 * React 前端静态托管：SPA 回退到 index.html；dist 缺失给出构建指引而非裸 404。
 *
 * 缓存（1b 验收）：外壳（`/`、`index.html`、SPA 回退）一律 `no-cache`——重启后浏览器每次都回来问，拿到新构建的入口；
 * 带内容哈希的 `assets/*` 长缓存 + `immutable`（文件名一变就是新文件）。其余零散文件同外壳，不长缓存。
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
};

export const SHELL_CACHE = "no-cache";
export const ASSET_CACHE = "public, max-age=31536000, immutable";

/** dist 内的相对路径 → 缓存策略 */
export function cacheControlFor(relFromDist: string): string {
  return relFromDist.split(path.sep).join("/").startsWith("assets/") ? ASSET_CACHE : SHELL_CACHE;
}

export async function serveApp(distDir: string, res: http.ServerResponse, rel: string): Promise<void> {
  const clean = rel.replace(/\.\.+/g, "").replace(/^\/+/, "");
  let file = path.join(distDir, clean || "index.html");
  if (!file.startsWith(distDir)) { res.writeHead(403).end("forbidden"); return; }
  try {
    await fs.access(file);
    if ((await fs.stat(file)).isDirectory()) throw new Error("dir");
  } catch {
    file = path.join(distDir, "index.html");
    try {
      await fs.access(file);
    } catch {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        .end("前端未构建：先执行 npm run fe:build 再刷新");
      return;
    }
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": cacheControlFor(path.relative(distDir, file)) });
  createReadStream(file).pipe(res);
}
