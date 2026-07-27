/**
 * fetch-image.test.ts — 素材下载器（深调研 §7）：SSRF / 格式双校验 / 尺寸 / 封顶。
 *
 * 全程本地假 HTTP server + 注入 lookup，**零出网**。图片样本是手搓的文件头
 * （本模块不解码，只读头），所以断言的都是确定性层，没有 LLM 参与。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchExternalImage, FetchImageError, type FetchImageOptions } from "./fetch-image.js";
import type { LookupFn } from "../../utils/guarded-fetch.js";

// ─── 样本构造（只造文件头，够解析尺寸即可）───────────────────────────────────

function png(width: number, height: number, tail = 32): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(tail, 7)]);
}

function jpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  // APP0：长度 16（含长度字段自身），载荷内容与尺寸解析无关
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  // SOF0：len=11 → precision(1) height(2) width(2) ncomp(1) + 单分量 3 字节
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  return Buffer.concat([soi, app0, sof, Buffer.from([0xff, 0xd9])]);
}

function riff(chunk: Buffer): Buffer {
  const out = Buffer.alloc(12 + chunk.length);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(4 + chunk.length, 4);
  out.write("WEBP", 8, "latin1");
  chunk.copy(out, 12);
  return out;
}

/** VP8（有损）：frame tag(3) + 同步码 9D 01 2A + 14 位宽高 */
function webpLossy(width: number, height: number): Buffer {
  const body = Buffer.alloc(18);
  body.write("VP8 ", 0, "latin1");
  body.writeUInt32LE(10, 4);
  body[11] = 0x9d;
  body[12] = 0x01;
  body[13] = 0x2a;
  body.writeUInt16LE(width, 14);
  body.writeUInt16LE(height, 16);
  return riff(body);
}

/** VP8L（无损）：签名 0x2F + 打包的「宽-1 / 高-1」各 14 位 */
function webpLossless(width: number, height: number): Buffer {
  const body = Buffer.alloc(13);
  body.write("VP8L", 0, "latin1");
  body.writeUInt32LE(5, 4);
  body[8] = 0x2f;
  body.writeUInt32LE(((((height - 1) << 14) | (width - 1)) >>> 0) & 0xfffffff, 9);
  return riff(body);
}

/** VP8X（扩展）：flags(1)+reserved(3) 后是 24 位画布「宽-1 / 高-1」 */
function webpExtended(width: number, height: number): Buffer {
  const body = Buffer.alloc(18);
  body.write("VP8X", 0, "latin1");
  body.writeUInt32LE(10, 4);
  body.writeUIntLE(width - 1, 12, 3);
  body.writeUIntLE(height - 1, 15, 3);
  return riff(body);
}

const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(20, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>evil()</script></svg>');
const SVG_XML_DECL = Buffer.from('<?xml version="1.0"?>\n<svg viewBox="0 0 10 10"></svg>');

// ─── 假 server ──────────────────────────────────────────────────────────────

const CHUNK = Buffer.alloc(64 * 1024, "a");
const SIX_MB = 6 * 1024 * 1024;
/** 无穷体的安全闸——只有「客户端把整个体读完」才可能撞到它 */
const ENDLESS_CAP = 64 * 1024 * 1024;

const publicLookup: LookupFn = async (hostname) =>
  hostname === "internal.test" ? ["10.0.0.5"] : ["93.184.216.34"];

let server: http.Server;
let port = 0;
let streamWritten = 0;
let serverClosed: Promise<void>;
let markServerClosed: () => void;
const pendingTimers = new Set<NodeJS.Timeout>();

/** 固定路由表：路径 → [content-type, 体] */
const ROUTES: Record<string, [string, Buffer]> = {
  "/png": ["image/png", png(1200, 800)],
  "/jpeg": ["image/jpeg", jpeg(640, 480)],
  "/webp-lossy": ["image/webp", webpLossy(1024, 768)],
  "/webp-lossless": ["image/webp", webpLossless(300, 200)],
  "/webp-extended": ["image/webp", webpExtended(4000, 2500)],
  "/webp-animated": ["image/webp", riff(Buffer.concat([Buffer.from("ANIM", "latin1"), Buffer.alloc(20)]))],
  "/gif": ["image/gif", GIF],
  "/gif-as-png": ["image/png", GIF],
  "/svg-as-png": ["image/png", SVG],
  "/svg-xml-as-png": ["image/png", SVG_XML_DECL],
  "/svg": ["image/svg+xml", SVG],
  "/html": ["text/html", Buffer.from("<html>404 page</html>")],
  "/too-wide": ["image/png", png(7000, 100)],
  "/too-tall": ["image/png", png(100, 6001)],
  "/edge-6000": ["image/png", png(6000, 6000)],
  "/truncated-png": ["image/png", png(10, 10).subarray(0, 20)],
  "/zero-size": ["image/png", png(0, 10)],
  "/empty": ["image/png", Buffer.alloc(0)],
};

function pump(res: http.ServerResponse, total: number): void {
  res.on("close", () => markServerClosed());
  const step = (): void => {
    while (streamWritten < total) {
      if (res.destroyed || res.writableEnded) return;
      streamWritten += CHUNK.length;
      if (!res.write(CHUNK)) {
        res.once("drain", step);
        return;
      }
    }
    res.end();
  };
  step();
}

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.on("error", () => {});
  const url = req.url ?? "/";
  const fixed = ROUTES[url];
  if (fixed) {
    res.writeHead(200, { "content-type": fixed[0] });
    return void res.end(fixed[1]);
  }
  const hop = /^\/hop\/(\d+)$/.exec(url);
  if (hop) {
    const n = Number(hop[1]);
    res.writeHead(302, { location: n > 1 ? `/hop/${n - 1}` : "/png" });
    return void res.end();
  }
  switch (url) {
    case "/no-type":
      res.writeHead(200);
      return void res.end(png(10, 10));
    case "/missing":
      res.writeHead(404, { "content-type": "image/png" });
      return void res.end("nope");
    case "/to-loopback":
      res.writeHead(302, { location: `http://127.0.0.1:${port}/png` });
      return void res.end();
    case "/to-private":
      res.writeHead(302, { location: "http://10.0.0.5/pic.png" });
      return void res.end();
    case "/to-internal-host":
      res.writeHead(302, { location: "http://internal.test/pic.png" });
      return void res.end();
    case "/big":
      res.writeHead(200, { "content-type": "image/png" });
      return pump(res, SIX_MB);
    case "/endless":
      res.writeHead(200, { "content-type": "image/png" });
      return pump(res, ENDLESS_CAP);
    case "/slow":
      pendingTimers.add(setTimeout(() => res.end(), 60_000));
      return;
    default:
      res.writeHead(404, { "content-type": "text/plain" });
      return void res.end("no route");
  }
}

beforeAll(async () => {
  server = http.createServer(handler);
  server.on("clientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const t of pendingTimers) clearTimeout(t);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  streamWritten = 0;
  serverClosed = new Promise<void>((resolve) => {
    markServerClosed = resolve;
  });
});

const base = (): string => `http://localhost:${port}`;
const get = (path: string, opts: FetchImageOptions = {}) =>
  fetchExternalImage(`${base()}${path}`, { lookup: publicLookup, ...opts });

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchImageError);
    return (err as FetchImageError).errorCode;
  }
  throw new Error("expected fetchExternalImage to throw, but it resolved");
}

// ─── 用例 ───────────────────────────────────────────────────────────────────

describe("格式白名单与 magic bytes 双校验", () => {
  it("PNG 下回来带格式、尺寸、字节与 finalUrl", async () => {
    const img = await get("/png");
    expect(img.format).toBe("png");
    expect(img.width).toBe(1200);
    expect(img.height).toBe(800);
    expect(img.finalUrl).toBe(`${base()}/png`);
    expect(img.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("JPEG 从 SOF0 段读尺寸（先跳过 APP0）", async () => {
    const img = await get("/jpeg");
    expect(img.format).toBe("jpeg");
    expect(img).toMatchObject({ width: 640, height: 480 });
  });

  it.each([
    ["VP8 有损", "/webp-lossy", 1024, 768],
    ["VP8L 无损", "/webp-lossless", 300, 200],
    ["VP8X 扩展", "/webp-extended", 4000, 2500],
  ])("WebP %s 头解析尺寸", async (_label, route, width, height) => {
    const img = await get(route);
    expect(img.format).toBe("webp");
    expect(img).toMatchObject({ width, height });
  });

  it("Content-Type 撒谎（标 image/png，体是 SVG）→ svg_rejected，不是 unsupported_format", async () => {
    expect(await codeOf(get("/svg-as-png"))).toBe("svg_rejected");
  });

  it("以 <?xml 开头的 SVG 同样按内容拒", async () => {
    expect(await codeOf(get("/svg-xml-as-png"))).toBe("svg_rejected");
  });

  it("Content-Type 就是 image/svg+xml → svg_rejected（门票这一层就拦下）", async () => {
    expect(await codeOf(get("/svg"))).toBe("svg_rejected");
  });

  it.each([
    ["GIF（诚实标 image/gif）", "/gif"],
    ["GIF 谎称 image/png（magic 是裁决）", "/gif-as-png"],
    ["非图片 Content-Type", "/html"],
    ["缺 Content-Type（fail closed）", "/no-type"],
    ["空响应体", "/empty"],
  ])("%s → unsupported_format", async (_label, route) => {
    expect(await codeOf(get(route))).toBe("unsupported_format");
  });
});

describe("像素尺寸闸", () => {
  it.each([
    ["宽 7000", "/too-wide"],
    ["高 6001", "/too-tall"],
  ])("%s → image_too_large", async (_label, route) => {
    expect(await codeOf(get(route))).toBe("image_too_large");
  });

  it("恰好 6000×6000 放行（是 > 不是 >=）", async () => {
    expect(await get("/edge-6000")).toMatchObject({ width: 6000, height: 6000 });
  });

  it.each([
    ["截断的 PNG 头", "/truncated-png"],
    ["宽为 0", "/zero-size"],
    ["WebP 动画（无画布头）", "/webp-animated"],
  ])("%s → bad_image", async (_label, route) => {
    expect(await codeOf(get(route))).toBe("bad_image");
  });
});

describe("字节封顶与超时", () => {
  it("6MB 体超过默认 5MB 上限 → body_too_large", async () => {
    expect(await codeOf(get("/big"))).toBe("body_too_large");
  });

  it("流式：无穷响应体被就地掐断，不整体读入内存", async () => {
    expect(await codeOf(get("/endless"))).toBe("body_too_large");
    // 等服务端收到断连（否则读的是竞态快照）：远未写完 64MB 即证明客户端没整体读入
    await serverClosed;
    expect(streamWritten).toBeLessThan(16 * 1024 * 1024);
  });

  it("maxBytes 可调低，小图也能被拦", async () => {
    expect(await codeOf(get("/png", { maxBytes: 8 }))).toBe("body_too_large");
  });

  it("不响应的服务端 → timeout", async () => {
    expect(await codeOf(get("/slow", { timeoutMs: 200 }))).toBe("timeout");
  });
});

describe("SSRF 与重定向纪律", () => {
  it("直接传环回地址被拦（默认 DNS，无注入）", async () => {
    expect(await codeOf(fetchExternalImage(`http://127.0.0.1:${port}/png`))).toBe("ssrf_blocked");
  });

  it.each([
    ["二跳指 127.0.0.1", "/to-loopback"],
    ["二跳指 10.x 私网", "/to-private"],
    ["二跳域名解析到内网", "/to-internal-host"],
  ])("%s —— 每跳复检拦住", async (_label, route) => {
    expect(await codeOf(get(route))).toBe("ssrf_blocked");
  });

  it("5 跳以内跟随成功，finalUrl 是跳转后的地址", async () => {
    const img = await get("/hop/5");
    expect(img.finalUrl).toBe(`${base()}/png`);
    expect(img.width).toBe(1200);
  });

  it("6 跳 → too_many_redirects", async () => {
    expect(await codeOf(get("/hop/6"))).toBe("too_many_redirects");
  });

  it("非 http(s) 与不可解析的链接", async () => {
    expect(await codeOf(fetchExternalImage("file:///etc/passwd"))).toBe("unsupported_protocol");
    expect(await codeOf(fetchExternalImage("not-a-url"))).toBe("invalid_url");
  });
});

describe("上游故障", () => {
  it("非 2xx → http_<status>", async () => {
    expect(await codeOf(get("/missing"))).toBe("http_404");
  });

  it("传输层抛错 → fetch_failed", async () => {
    const code = await codeOf(
      get("/png", {
        fetchImpl: async () => {
          throw new Error("socket hang up");
        },
      }),
    );
    expect(code).toBe("fetch_failed");
  });
});
