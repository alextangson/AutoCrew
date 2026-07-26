import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  fetchExternalPage,
  isBlockedAddress,
  collectImageCandidates,
  FetchExternalError,
  type LookupFn,
} from "./fetch-external.js";

const HTML =
  "<html><head><title>外部标题</title></head><body><h1>正文标题</h1><p>第一段。</p>" +
  "<script>evil_payload()</script></body></html>";

/** 图片页放在多级路径下：相对 URL 必须按 **finalUrl** 解析，跳转前的路径解出来不一样 */
const IMG_HTML =
  '<html><head><title>图页</title><meta property="og:image" content="https://cdn.test/hero.jpg"></head>' +
  '<body><img src="pic.png" width="800"><p>正文</p></body></html>';
const CHUNK = Buffer.alloc(64 * 1024, "a");
const THREE_MB = 3 * 1024 * 1024;
/** 无穷体的安全闸——只有「客户端把整个体读完」才可能撞到它 */
const ENDLESS_CAP = 64 * 1024 * 1024;

/** 测试注入：让守卫把环回测试服看成公网地址；internal.test 模拟「域名解析到内网」 */
const publicLookup: LookupFn = async (hostname) =>
  hostname === "internal.test" ? ["10.0.0.5"] : ["93.184.216.34"];

let server: http.Server;
let port = 0;
let streamWritten = 0;
/** 服务端响应关闭的信号——客户端断连或写完都会触发，用它替代「读快照」的竞态断言 */
let serverClosed: Promise<void>;
let markServerClosed: () => void;
const pendingTimers = new Set<NodeJS.Timeout>();

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

/** 分块写，尊重背压；客户端断连即停 */
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
  const path = req.url ?? "/";
  const hop = /^\/hop\/(\d+)$/.exec(path);
  if (hop) {
    const n = Number(hop[1]);
    return redirect(res, n > 1 ? `/hop/${n - 1}` : "/ok");
  }
  switch (path) {
    case "/ok":
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(HTML);
    case "/plain":
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("  纯文本正文。  ");
    case "/json":
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end('{"a":1}');
    case "/no-type":
      res.writeHead(200);
      return void res.end("裸响应");
    case "/missing":
      res.writeHead(404, { "content-type": "text/html" });
      return void res.end("<html>404</html>");
    case "/deep/dir/imgs":
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(IMG_HTML);
    case "/imgs-hop":
      return redirect(res, "/deep/dir/imgs");
    case "/to-loopback":
      return redirect(res, `http://127.0.0.1:${port}/ok`);
    case "/to-private":
      return redirect(res, "http://10.0.0.5/ok");
    case "/to-internal-host":
      return redirect(res, "http://internal.test/ok");
    case "/to-file":
      return redirect(res, "file:///etc/passwd");
    case "/big":
      res.writeHead(200, { "content-type": "text/html" });
      return pump(res, THREE_MB);
    case "/endless":
      res.writeHead(200, { "content-type": "text/html" });
      return pump(res, ENDLESS_CAP);
    case "/slow":
      pendingTimers.add(setTimeout(() => res.end(), 60_000));
      return;
    default:
      res.writeHead(404, { "content-type": "text/plain" });
      return void res.end("no route");
  }
}

/** 断言抛的是带 errorCode 的 FetchExternalError，并返回 code */
async function errorCodeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchExternalError);
    return (err as FetchExternalError).errorCode;
  }
  throw new Error("expected fetchExternalPage to throw, but it resolved");
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

describe("fetchExternalPage — 协议与 URL", () => {
  it("拒绝非 http/https 与不可解析的链接", async () => {
    expect(await errorCodeOf(fetchExternalPage("file:///etc/passwd"))).toBe("unsupported_protocol");
    expect(await errorCodeOf(fetchExternalPage("ftp://example.com/x"))).toBe("unsupported_protocol");
    expect(await errorCodeOf(fetchExternalPage("not-a-url"))).toBe("invalid_url");
  });

  it("重定向到非 http 协议也拒绝", async () => {
    expect(await errorCodeOf(fetchExternalPage(`${base()}/to-file`, { lookup: publicLookup }))).toBe(
      "unsupported_protocol",
    );
  });
});

describe("fetchExternalPage — 正常抓取", () => {
  it("返回正文、标题与 finalUrl，并剥掉脚本", async () => {
    const page = await fetchExternalPage(`${base()}/ok`, { lookup: publicLookup });
    expect(page.finalUrl).toBe(`${base()}/ok`);
    expect(page.title).toBe("外部标题");
    expect(page.text).toContain("正文标题");
    expect(page.text).toContain("第一段。");
    expect(page.text).not.toContain("evil_payload");
    expect(page.text).not.toContain("<p>");
  });

  it("text/plain 原样返回、无标题", async () => {
    const page = await fetchExternalPage(`${base()}/plain`, { lookup: publicLookup });
    expect(page.text).toBe("纯文本正文。");
    expect(page.title).toBeUndefined();
  });

  it("finalUrl 是跳转后的地址（相对 Location 也能解析）", async () => {
    const page = await fetchExternalPage(`${base()}/hop/2`, { lookup: publicLookup });
    expect(page.finalUrl).toBe(`${base()}/ok`);
    expect(page.text).toContain("正文标题");
  });

  it("非 2xx 带 http_<status>", async () => {
    expect(await errorCodeOf(fetchExternalPage(`${base()}/missing`, { lookup: publicLookup }))).toBe(
      "http_404",
    );
  });
});

describe("fetchExternalPage — 重定向纪律", () => {
  it("5 跳以内跟随成功", async () => {
    const page = await fetchExternalPage(`${base()}/hop/5`, { lookup: publicLookup });
    expect(page.finalUrl).toBe(`${base()}/ok`);
  });

  it("6 跳报 too_many_redirects", async () => {
    expect(await errorCodeOf(fetchExternalPage(`${base()}/hop/6`, { lookup: publicLookup }))).toBe(
      "too_many_redirects",
    );
  });
});

describe("fetchExternalPage — SSRF 防护", () => {
  it("直接传环回地址被拦（默认 DNS，无注入）", async () => {
    expect(await errorCodeOf(fetchExternalPage(`http://127.0.0.1:${port}/ok`))).toBe("ssrf_blocked");
  });

  it("localhost 解析后自然被拦（默认 DNS，无注入）", async () => {
    expect(await errorCodeOf(fetchExternalPage(`${base()}/ok`))).toBe("ssrf_blocked");
  });

  it("首跳干净、二跳指 127.0.0.1 —— 每跳复检拦住", async () => {
    expect(
      await errorCodeOf(fetchExternalPage(`${base()}/to-loopback`, { lookup: publicLookup })),
    ).toBe("ssrf_blocked");
  });

  it("二跳指 10.x 私网被拦", async () => {
    expect(
      await errorCodeOf(fetchExternalPage(`${base()}/to-private`, { lookup: publicLookup })),
    ).toBe("ssrf_blocked");
  });

  it("二跳域名解析到内网被拦（DNS 路径，不是字面量）", async () => {
    expect(
      await errorCodeOf(fetchExternalPage(`${base()}/to-internal-host`, { lookup: publicLookup })),
    ).toBe("ssrf_blocked");
  });
});

describe("fetchExternalPage — 响应校验", () => {
  it("application/json 报 unsupported_content_type", async () => {
    expect(await errorCodeOf(fetchExternalPage(`${base()}/json`, { lookup: publicLookup }))).toBe(
      "unsupported_content_type",
    );
  });

  it("缺 Content-Type 也拒绝（fail closed）", async () => {
    expect(await errorCodeOf(fetchExternalPage(`${base()}/no-type`, { lookup: publicLookup }))).toBe(
      "unsupported_content_type",
    );
  });

  it("3MB 响应报 body_too_large", async () => {
    expect(await errorCodeOf(fetchExternalPage(`${base()}/big`, { lookup: publicLookup }))).toBe(
      "body_too_large",
    );
  });

  it("流式：无穷响应体被就地掐断，不整体读入内存", async () => {
    const code = await errorCodeOf(fetchExternalPage(`${base()}/endless`, { lookup: publicLookup }));
    expect(code).toBe("body_too_large");
    // 等服务端那侧收到断连（否则读的是竞态快照）：远未写完 64MB 即证明客户端没整体读入
    await serverClosed;
    expect(streamWritten).toBeLessThan(16 * 1024 * 1024);
  });

  it("超时报 timeout", async () => {
    expect(
      await errorCodeOf(fetchExternalPage(`${base()}/slow`, { lookup: publicLookup, timeoutMs: 200 })),
    ).toBe("timeout");
  });
});

describe("isBlockedAddress", () => {
  const blocked = [
    // IPv4 环回 / 私网 / 链路本地 / 本网络（边界值成对给）
    "127.0.0.1", "127.255.255.255",
    "10.0.0.0", "10.255.255.255",
    "172.16.0.0", "172.31.255.255",
    "192.168.0.0", "192.168.255.255",
    "169.254.0.0", "169.254.169.254", "169.254.255.255",
    "0.0.0.0", "0.255.255.255",
    // IPv6 未指定 / 环回 / ULA / 链路本地
    "::", "::1", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe80::1", "febf:ffff::1", "fe80::1%en0",
    // IPv4-mapped 与已废弃的 IPv4-compatible 形态
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:192.168.1.1",
    "::ffff:172.16.0.1", "::ffff:169.254.169.254", "::ffff:0.0.0.0", "::127.0.0.1",
    // 解析不出来的一律 fail closed
    "not-an-ip", "", "127.0.0.256", "localhost",
  ];
  const allowed = [
    "8.8.8.8", "1.1.1.1", "93.184.216.34",
    "9.255.255.255", "11.0.0.0",
    "172.15.255.255", "172.32.0.0",
    "192.167.255.255", "192.169.0.0",
    "169.253.255.255", "169.255.0.0",
    "1.0.0.0", "126.255.255.255", "128.0.0.1",
    "2001:4860:4860::8888", "2606:4700:4700::1111",
    "fbff:ffff::1", "fe00::1", "fec0::1",
    "::ffff:8.8.8.8", "::ffff:93.184.216.34",
  ];

  it.each(blocked)("拦 %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(allowed)("放行 %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

// ─── 图片候选采集（深调研 R1a）────────────────────────────────────────────────

const PAGE_URL = "https://ex.test/a/b/page.html";
const urls = (html: string, base = PAGE_URL): string[] =>
  collectImageCandidates(html, base).map((c) => c.url);

describe("collectImageCandidates — 抽取", () => {
  it("srcset 取像素描述最大的候选，标 sourceAttr=srcset", () => {
    const html = '<img src="fallback.jpg" srcset="s.jpg 320w, l.jpg 1600w, m.jpg 800w">';
    expect(collectImageCandidates(html, PAGE_URL)).toEqual([
      { url: "https://ex.test/a/b/l.jpg", sourceAttr: "srcset" },
    ]);
  });

  it("srcset 的 x 描述子与无描述子混排也取最大", () => {
    expect(urls('<img srcset="a.jpg, b.jpg 2x, c.jpg 1.5x">')).toEqual(["https://ex.test/a/b/b.jpg"]);
  });

  it("srcset 最大候选被跳过时回落 src", () => {
    const html = '<img src="ok.png" srcset="logo.svg 1600w">';
    expect(collectImageCandidates(html, PAGE_URL)).toEqual([
      { url: "https://ex.test/a/b/ok.png", sourceAttr: "img" },
    ]);
  });

  it("相对 URL 按 base 解析（同级/上级/根/协议相对）", () => {
    const html =
      '<img src="pic.png"><img src="../up.png"><img src="/root.png"><img src="//cdn.test/x.png">';
    expect(urls(html)).toEqual([
      "https://ex.test/a/b/pic.png",
      "https://ex.test/a/up.png",
      "https://ex.test/root.png",
      "https://cdn.test/x.png",
    ]);
  });

  it("og:image 排在最前（属性顺序与 name= 写法都认）", () => {
    const html =
      '<meta content="https://cdn.test/hero.jpg" name="og:image"><img src="pic.png">';
    expect(collectImageCandidates(html, PAGE_URL)).toEqual([
      { url: "https://cdn.test/hero.jpg", sourceAttr: "og" },
      { url: "https://ex.test/a/b/pic.png", sourceAttr: "img" },
    ]);
  });

  it("HTML 实体 &amp; 还原成 &", () => {
    expect(urls('<img src="https://cdn.test/x.png?a=1&amp;b=2">')).toEqual([
      "https://cdn.test/x.png?a=1&b=2",
    ]);
  });

  it("页内按绝对 URL 去重", () => {
    expect(urls('<img src="pic.png"><img src="/a/b/pic.png"><img src="pic.png">')).toEqual([
      "https://ex.test/a/b/pic.png",
    ]);
  });

  it("脚本/样式里的 img 不算数", () => {
    expect(urls('<script><img src="fake.png"></script><style><img src="s.png"></style>')).toEqual([]);
  });

  it("base 不可解析时返回空，不抛", () => {
    expect(collectImageCandidates('<img src="pic.png">', "not-a-url")).toEqual([]);
  });
});

describe("collectImageCandidates — 跳过规则", () => {
  const skipped: Array<[string, string]> = [
    ["data: URI", '<img src="data:image/png;base64,iVBORw0KGgo=">'],
    [".svg 后缀", '<img src="logo.svg">'],
    [".svg 带查询串", '<img src="logo.svg?v=2">'],
    ["路径含 pixel", '<img src="https://cdn.test/pixel/track.gif">'],
    ["域名含 tracker", '<img src="https://tracker.test/x.png">'],
    ["查询串含 beacon", '<img src="https://cdn.test/x.png?m=beacon">'],
    ["width < 200", '<img src="small.png" width="120">'],
    ["height < 200", '<img src="small.png" height="1">'],
    ["非 http(s) 协议", '<img src="ftp://ex.test/x.png">'],
    ["空 src", '<img src="" alt="x">'],
  ];
  it.each(skipped)("跳过 %s", (_label, html) => {
    expect(urls(html)).toEqual([]);
  });

  const kept: Array<[string, string]> = [
    ["尺寸恰为 200（不是 <200）", '<img src="ok.png" width="200" height="200">'],
    ["百分比宽度不当像素判", '<img src="ok.png" width="100%">'],
    ["无尺寸属性", '<img src="ok.png">'],
    ["px 后缀的大尺寸", '<img src="ok.png" width="640px">'],
  ];
  it.each(kept)("保留 %s", (_label, html) => {
    expect(urls(html)).toEqual(["https://ex.test/a/b/ok.png"]);
  });
});

describe("collectImageCandidates — 上限", () => {
  it("每页最多 10 条（含 og:image 占位）", () => {
    const html =
      '<meta property="og:image" content="https://cdn.test/hero.jpg">' +
      Array.from({ length: 15 }, (_, i) => `<img src="p${i}.png">`).join("");
    const got = collectImageCandidates(html, PAGE_URL);
    expect(got).toHaveLength(10);
    expect(got[0].sourceAttr).toBe("og");
    expect(got[9].url).toBe("https://ex.test/a/b/p8.png");
  });
});

describe("fetchExternalPage — collectImages 开关", () => {
  it("默认关闭：返回值形状不含 imageCandidates", async () => {
    const page = await fetchExternalPage(`${base()}/deep/dir/imgs`, { lookup: publicLookup });
    expect("imageCandidates" in page).toBe(false);
    expect(Object.keys(page).sort()).toEqual(["finalUrl", "text", "title"]);
  });

  it("显式 false 也不带该字段", async () => {
    const page = await fetchExternalPage(`${base()}/deep/dir/imgs`, {
      lookup: publicLookup,
      collectImages: false,
    });
    expect("imageCandidates" in page).toBe(false);
  });

  it("开启后带候选，相对 URL 按 finalUrl（跳转后）解析，正文不受影响", async () => {
    const page = await fetchExternalPage(`${base()}/imgs-hop`, {
      lookup: publicLookup,
      collectImages: true,
    });
    expect(page.finalUrl).toBe(`${base()}/deep/dir/imgs`);
    expect(page.title).toBe("图页");
    expect(page.text).toContain("正文");
    expect(page.imageCandidates).toEqual([
      { url: "https://cdn.test/hero.jpg", sourceAttr: "og" },
      { url: `${base()}/deep/dir/pic.png`, sourceAttr: "img" },
    ]);
  });

  it("text/plain 开启后是空数组（字段存在性只跟随请求，不跟随内容）", async () => {
    const page = await fetchExternalPage(`${base()}/plain`, {
      lookup: publicLookup,
      collectImages: true,
    });
    expect(page.text).toBe("纯文本正文。");
    expect(page.imageCandidates).toEqual([]);
  });
});
