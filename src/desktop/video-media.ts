/**
 * 成片播放端点（设计 spec §6.4 / codex #3）：`GET /api/video/media/<contentId>/<file>`。
 *
 * 为什么要它：审片视图里的 `<video>` 播不了 `file://`，没有这个端点整条视频线到
 * review 就断了。接线在 desktop/server.ts，逻辑放这里——server.ts 不在 vitest 的
 * include 范围内，端点的安全面必须能被测试真跑到。
 *
 * 四条纪律：
 * 1. **鉴权沿用 server 现有那套**：调用方注入 `authorize`（= server 的 session/bearer
 *    判定），本模块不发明第二套 token 机制；未过 → 403（与 /api/asset 同款）。
 * 2. **路径三重锁**：contentId 白名单正则 + 单段安全文件名 + 扩展名白名单，最后再用
 *    realpath 把结果钉死在 `contents/<id>/video|assets/` 里（软链接也逃不出去）。
 * 3. **Range 必须支持**：前端拖进度条会发 `Range: bytes=…`，只给 200 全量的实现在
 *    长视频上等于不能拖（206/416/Content-Range 全套）。
 * 4. **403 与 404 分开**：路径/扩展名非法 = 403（这是拒绝，不是「没找到」），
 *    文件真不在 = 404——排障时这两种是完全不同的病因。
 */
import type http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { isContentId } from "../storage/entity-id.js";

export const VIDEO_MEDIA_PREFIX = "/api/video/media/";

/** 成片与中间产物：mp4 是成片，wav 是转写输入/主音轨（排障时要能直接听） */
const MEDIA_MIME: Record<string, string> = { ".mp4": "video/mp4", ".wav": "audio/wav" };
/** 只认这两个目录：video/ 是中间产物，assets/ 是已登记成片（§6.4） */
const MEDIA_DIRS = ["video", "assets"] as const;
const SAFE_FILE_RE = /^[A-Za-z0-9._-]+$/;

export interface VideoMediaDeps {
  /** 当前工作区 dataDir（server 端解析，前端永远传不进路径） */
  resolveDataDir: () => Promise<string>;
  /** server 的鉴权判定：true = 放行 */
  authorize: (req: http.IncomingMessage) => boolean;
}

interface Target {
  contentId: string;
  file: string;
}

/** `/api/video/media/<contentId>/<file>` → 目标；形状不对或含穿越即 null */
export function parseMediaPath(pathname: string): Target | null {
  if (!pathname.startsWith(VIDEO_MEDIA_PREFIX)) return null;
  const rest = pathname.slice(VIDEO_MEDIA_PREFIX.length).split("/");
  if (rest.length !== 2) return null;
  let contentId: string;
  let file: string;
  try {
    // 编码过的 %2e%2e%2f 在 URL.pathname 里原样保留，必须先解码再校验
    contentId = decodeURIComponent(rest[0]);
    file = decodeURIComponent(rest[1]);
  } catch {
    return null;
  }
  if (!isContentId(contentId)) return null;
  if (!SAFE_FILE_RE.test(file) || file.includes("..")) return null;
  if (!(path.extname(file).toLowerCase() in MEDIA_MIME)) return null;
  return { contentId, file };
}

/** 在两个白名单目录里找文件；realpath 之后仍在目录内才算数（防软链接逃逸） */
async function resolveMediaFile(dataDir: string, target: Target): Promise<string | null> {
  for (const sub of MEDIA_DIRS) {
    const base = path.join(dataDir, "contents", target.contentId, sub);
    try {
      const realBase = await fs.realpath(base);
      const real = await fs.realpath(path.join(base, target.file));
      if (real !== realBase && !real.startsWith(realBase + path.sep)) continue;
      if ((await fs.stat(real)).isFile()) return real;
    } catch {
      continue; // 该目录不存在/文件不在，换下一个
    }
  }
  return null;
}

export type RangeResult = { start: number; end: number } | "unsatisfiable" | null;

/** RFC 7233 单区间；语法不认的 Range 按「没带」处理（回 200 全量），越界才 416 */
export function parseRangeHeader(header: string | undefined, size: number): RangeResult {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix <= 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

function sendStream(
  res: http.ServerResponse,
  file: string,
  ext: string,
  range: { start: number; end: number } | null,
  size: number,
): void {
  const headers: Record<string, string> = {
    "Content-Type": MEDIA_MIME[ext],
    "Accept-Ranges": "bytes",
    // 成片文件名带 revision，但重渲染同名 .failed→重试的边界不值得赌缓存：一律不缓存
    "Cache-Control": "no-store",
  };
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    res.writeHead(206, headers);
  } else {
    headers["Content-Length"] = String(size);
    res.writeHead(200, headers);
  }
  const stream = range ? createReadStream(file, { start: range.start, end: range.end }) : createReadStream(file);
  stream.on("error", () => res.destroy()); // 读到一半坏了：断连，不发半截 200
  stream.pipe(res);
}

/**
 * 处理媒体请求。返回 false = 这不是媒体路径，交回 server 继续路由；
 * 返回 true = 已经把响应写完（含各种拒绝）。
 */
export function createVideoMediaHandler(
  deps: VideoMediaDeps,
): (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => Promise<boolean> {
  return async (req, res, pathname) => {
    if (!pathname.startsWith(VIDEO_MEDIA_PREFIX)) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return true;
    }
    if (!deps.authorize(req)) {
      res.writeHead(403).end();
      return true;
    }
    const target = parseMediaPath(pathname);
    if (!target) {
      res.writeHead(403).end("bad media path");
      return true;
    }
    const dataDir = await deps.resolveDataDir();
    const file = await resolveMediaFile(dataDir, target);
    if (!file) {
      res.writeHead(404).end("not found");
      return true;
    }
    const size = (await fs.stat(file)).size;
    const range = parseRangeHeader(req.headers.range, size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" }).end();
      return true;
    }
    sendStream(res, file, path.extname(file).toLowerCase(), range, size);
    return true;
  };
}
