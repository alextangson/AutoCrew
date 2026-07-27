/**
 * 本地素材 HTTP 服务。
 *
 * 为什么需要它：@remotion/renderer 的素材下载器**只认 http:// / https:// / data:**
 * （node_modules/@remotion/renderer/dist/assets/read-file.js：其余协议直接抛
 * `Can only download URLs starting with http:// or https://`），
 * 所以 manifest 里的绝对路径不能直接塞给 <Audio>/<OffthreadVideo>/<Img>。
 * 这里起一个只跑在 127.0.0.1、随机端口、**白名单式**的静态服务，把绝对路径映射成 URL，
 * 渲染结束即关闭。素材不复制、不进 public/。
 */
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export type AssetServer = {
  /** 绝对路径 → 可被 Remotion 消费的 http URL。路径必须在构造时登记过。 */
  urlFor: (absPath: string) => string;
  origin: string;
  close: () => Promise<void>;
};

/**
 * @param absPaths 允许被访问的绝对路径白名单（manifest 里出现过的素材）。
 */
export async function startAssetServer(absPaths: readonly string[]): Promise<AssetServer> {
  const unique = [...new Set(absPaths.map((p) => path.resolve(p)))];
  const byToken = new Map<string, string>();
  const tokenByPath = new Map<string, string>();
  unique.forEach((abs, index) => {
    const token = String(index);
    byToken.set(token, abs);
    tokenByPath.set(abs, token);
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/a\/([^/]+)\//.exec(url.pathname);
    const abs = match ? byToken.get(decodeURIComponent(match[1]!)) : undefined;
    if (!abs) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('未登记的素材');
      return;
    }

    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('素材文件读不到');
      return;
    }

    const contentType = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const range = req.headers.range;
    const rangeMatch = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;

    if (rangeMatch) {
      const startRaw = rangeMatch[1];
      const endRaw = rangeMatch[2];
      const start = startRaw ? Number(startRaw) : Math.max(0, size - Number(endRaw ?? 0));
      const end = endRaw && startRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-type': contentType,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(abs, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(size),
      'accept-ranges': 'bytes',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(abs).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    urlFor: (absPath: string) => {
      const abs = path.resolve(absPath);
      const token = tokenByPath.get(abs);
      if (!token) throw new Error(`素材未登记到本地素材服务：${abs}`);
      // 末段保留原文件名，Remotion 靠扩展名推断素材类型。
      return `${origin}/a/${token}/${encodeURIComponent(path.basename(abs))}`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
