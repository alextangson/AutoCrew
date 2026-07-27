/**
 * video-media.test.ts —— 成片播放端点的契约：**真起 server 于随机端口**，走真 HTTP。
 * 鉴权用真的 LocalSessionAuth（与 server.ts 同一个类），不是自己写的假门。
 *
 * 覆盖矩阵：200 全量 / 206 区间(三种写法) / 416 越界 / 路径穿越 / 软链接逃逸 /
 * 扩展名白名单 / 未鉴权 / 目录白名单(video 与 assets) / 非媒体路径放行。
 */
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LocalSessionAuth } from "./server-auth.js";
import { createVideoMediaHandler, parseRangeHeader } from "./video-media.js";

const TOKEN = "test-token-0123456789";
const CONTENT_ID = "content-1753600000000-abc123";
/** 32 字节可辨识内容：区间断言直接比字节，不比长度 */
const BODY = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUV");

let dir: string;
let server: http.Server;
let base: string;

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-media-"));
  const videoDir = path.join(dir, "contents", CONTENT_ID, "video");
  const assetsDir = path.join(dir, "contents", CONTENT_ID, "assets");
  await fs.mkdir(videoDir, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.writeFile(path.join(videoDir, "final.v1.mp4"), BODY);
  await fs.writeFile(path.join(videoDir, "anchor.v2.wav"), BODY);
  await fs.writeFile(path.join(videoDir, "notes.txt"), "不该被端点吐出去");
  await fs.writeFile(path.join(assetsDir, "final-v1.mp4"), BODY);
  // 仓库外的秘密 + 指向它的软链接：realpath 之后必须逃不出白名单目录
  await fs.writeFile(path.join(dir, "secret.mp4"), "SECRET");
  await fs.symlink(path.join(dir, "secret.mp4"), path.join(videoDir, "escape.mp4"));

  const auth = new LocalSessionAuth(TOKEN, new Set([]));
  const handler = createVideoMediaHandler({
    resolveDataDir: async () => dir,
    authorize: (req) =>
      auth.authenticate({ authorization: req.headers.authorization, cookie: req.headers.cookie }) !== null,
  });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (await handler(req, res, url.pathname)) return;
    res.writeHead(404).end("no route");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fs.rm(dir, { recursive: true, force: true });
});

describe("GET /api/video/media —— 全量与区间", () => {
  it("200：全量带 Content-Length 与 Accept-Ranges（<video> 靠它判断能不能拖）", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final.v1.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(BODY.length));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BODY);
  });

  it("206：闭区间返回那一段字节与 Content-Range", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final.v1.mp4`, { headers: { Range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${BODY.length}`);
    expect(res.headers.get("content-length")).toBe("10");
    expect(await res.text()).toBe("ABCDEFGHIJ");
  });

  it("206：开区间 bytes=N- 直到文件末尾", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final.v1.mp4`, { headers: { Range: "bytes=26-" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 26-31/${BODY.length}`);
    expect(await res.text()).toBe("QRSTUV");
  });

  it("206：后缀 bytes=-N 取末尾 N 字节", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final.v1.mp4`, { headers: { Range: "bytes=-6" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 26-31/${BODY.length}`);
    expect(await res.text()).toBe("QRSTUV");
  });

  it("416：越界区间带 Content-Range: bytes */size", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final.v1.mp4`, { headers: { Range: "bytes=99999-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${BODY.length}`);
  });

  it("语法不认的 Range 按没带处理（RFC 7233）——回 200 全量而不是 416", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final.v1.mp4`, { headers: { Range: "items=0-1" } });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BODY);
  });
});

describe("GET /api/video/media —— 白名单与拒绝", () => {
  it("assets/ 下的成片同样可播（成片登记走既有 Asset 语义）", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final-v1.mp4`);
    expect(res.status).toBe(200);
  });

  it("wav 也在白名单（转写输入/主音轨要能直接听）", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/anchor.v2.wav`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
  });

  it("无 token：403，不吐任何字节", async () => {
    const res = await fetch(`${base}/api/video/media/${CONTENT_ID}/final.v1.mp4`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("0123456789");
  });

  it("错 token 同样 403", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final.v1.mp4`, {
      headers: { Authorization: "Bearer wrong-token-0123456" },
    });
    expect(res.status).toBe(403);
  });

  it.each([
    ["编码过的 ../ 穿越", `/api/video/media/${CONTENT_ID}/%2e%2e%2fsecret.mp4`],
    ["斜杠穿越（多段路径）", `/api/video/media/${CONTENT_ID}/sub%2fdir%2ffinal.v1.mp4`],
    ["扩展名不在白名单", `/api/video/media/${CONTENT_ID}/notes.txt`],
    ["contentId 非法", `/api/video/media/..%2f..%2fetc/final.v1.mp4`],
  ])("%s → 403 拒绝", async (_label, url) => {
    const res = await get(url);
    expect(res.status).toBe(403);
  });

  it("软链接逃逸：realpath 出了白名单目录 → 当作不存在（404）", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/escape.mp4`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SECRET");
  });

  it("文件真不在 → 404（与「拒绝」区分开，排障时是两种病因）", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final.v9.mp4`);
    expect(res.status).toBe(404);
  });

  it("别的 content 的目录不存在 → 404", async () => {
    const res = await get(`/api/video/media/content-1753600000000-zzz999/final.v1.mp4`);
    expect(res.status).toBe(404);
  });

  it("非媒体路径原样放行给 server 继续路由", async () => {
    const res = await get(`/api/something-else`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("no route");
  });

  it("写方法一律 405（这是只读端点）", async () => {
    const res = await get(`/api/video/media/${CONTENT_ID}/final.v1.mp4`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("parseRangeHeader", () => {
  it.each([
    [undefined, 100, null],
    ["bytes=0-9", 100, { start: 0, end: 9 }],
    ["bytes=50-", 100, { start: 50, end: 99 }],
    ["bytes=-20", 100, { start: 80, end: 99 }],
    ["bytes=0-999", 100, { start: 0, end: 99 }], // 末端夹到 size-1
    ["bytes=100-", 100, "unsatisfiable"],
    ["bytes=-0", 100, "unsatisfiable"],
    ["bytes=0-9", 0, "unsatisfiable"], // 空文件没有任何可满足区间
    ["bytes=9-5", 100, "unsatisfiable"],
    ["bytes=a-b", 100, null],
    ["bytes=0-1,5-6", 100, null], // 多区间不支持 → 当没带
  ])("%s / size %d", (header, size, expected) => {
    expect(parseRangeHeader(header as string | undefined, size)).toEqual(expected);
  });
});
