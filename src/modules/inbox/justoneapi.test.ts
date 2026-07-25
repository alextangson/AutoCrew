/**
 * justoneapi 抖音解析器 · 契约测试（spec §3.2）。
 *
 * 全程假服务器、零出网：错误码矩阵、两个端点的 happy path、开放跳转防护、超时与坏响应。
 * fixture 骨架照 2026-07-25 创始人 key 实测的真实结构裁剪（只留用得上的字段）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  classifyJustoneapiCode,
  createJustoneapiClient,
  extractDouyinVideoId,
  isDouyinShareLink,
  isDouyinUrl,
  JustoneapiError,
  type JustoneapiClient,
} from "./justoneapi.js";

const VIDEO_ID = "7656056306591884643";

/** 实测骨架（字段裁剪到解析器用得上的部分）：视频对象藏在嵌套里，键名 aweme_info */
const AWEME_INFO = {
  aweme_id: VIDEO_ID,
  desc: "做AI Agent整整一年了…\n这是文案第二行",
  create_time: 1782823718,
  author: { uid: "98765432100", nickname: "Ai-Agent", follower_count: 0 },
  statistics: {
    digg_count: 135,
    comment_count: 11,
    collect_count: 132,
    share_count: 29,
    play_count: 0,
  },
  video: { duration: 866934 },
};

function wrap(data: unknown): string {
  return JSON.stringify({
    code: 0,
    data,
    message: "success",
    recordTime: "2026-07-25 13:00:00",
    requestId: "req-test-1",
  });
}

let server: http.Server;
let baseUrl = "";
/** 服务端看到的 token —— 用来锁死「token 走 query 参数」这条契约 */
let seenTokens: string[] = [];
const pendingTimers = new Set<NodeJS.Timeout>();

function respond(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

/** 业务码由入参驱动：`code-<n>` 让同一个假服务器跑完整张错误码矩阵 */
function scripted(res: http.ServerResponse, key: string, onOk: () => void): void {
  const code = /^code-(\d+)$/.exec(key);
  if (code) return respond(res, 200, JSON.stringify({ code: Number(code[1]), message: "上游说不行", data: null }));
  const httpStatus = /^http-(\d+)$/.exec(key);
  if (httpStatus) return respond(res, Number(httpStatus[1]), JSON.stringify({ error: "boom" }));
  if (key === "not-json") return respond(res, 200, "<html>网关错误页</html>");
  if (key === "no-code") return respond(res, 200, JSON.stringify({ data: { aweme_info: AWEME_INFO } }));
  if (key === "slow") {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      respond(res, 200, wrap({ aweme_info: AWEME_INFO }));
    }, 2_000);
    pendingTimers.add(timer);
    return;
  }
  onOk();
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.on("error", () => {});
  const url = new URL(req.url ?? "/", baseUrl || "http://127.0.0.1");
  seenTokens.push(url.searchParams.get("token") ?? "(缺失)");

  if (url.pathname === "/api/douyin/share-url-transfer/v1") {
    const share = url.searchParams.get("shareUrl") ?? "";
    const key = share.replace("https://v.douyin.com/", "").replace(/\/$/, "");
    return scripted(res, key, () => {
      if (key === "foreign") return respond(res, 200, wrap({ url: "https://evil.example.com/steal?next=douyin.com" }));
      if (key === "nourl") return respond(res, 200, wrap({ note: "解析完成", id: 7 }));
      if (key === "ies") return respond(res, 200, wrap({ url: `https://www.iesdouyin.com/share/video/${VIDEO_ID}/?region=CN` }));
      respond(res, 200, wrap({ url: `https://www.douyin.com/video/${VIDEO_ID}?previous_page=app_code_link` }));
    });
  }

  if (url.pathname === "/api/douyin/get-video-detail/v2") {
    const videoId = url.searchParams.get("videoId") ?? "";
    return scripted(res, videoId, () => {
      if (videoId === "no-video") return respond(res, 200, wrap({ status_code: 0, extra: {} }));
      // 文档另有 aweme_detail 键名，两种都要认
      if (videoId === "detail-key") return respond(res, 200, wrap({ aweme_detail: AWEME_INFO }));
      if (videoId === "no-id") {
        const { aweme_id: _drop, ...rest } = AWEME_INFO;
        return respond(res, 200, wrap({ wrapper: { aweme_info: rest } }));
      }
      respond(res, 200, wrap({ wrapper: { aweme_info: AWEME_INFO } }));
    });
  }
  respond(res, 404, JSON.stringify({ code: 404 }));
}

function client(timeoutMs = 5_000): JustoneapiClient {
  return createJustoneapiClient("test-token", { baseUrl, timeoutMs });
}

async function caught(fn: () => Promise<unknown>): Promise<JustoneapiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof JustoneapiError) return err;
    throw err;
  }
  throw new Error("期望抛 JustoneapiError，实际没抛");
}

beforeAll(async () => {
  server = http.createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const t of pendingTimers) clearTimeout(t);
  pendingTimers.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// --- 域名判定与 id 抠取（管线路由的判据） ---

describe("justoneapi · 域名与 videoId", () => {
  it("三个抖音域名都命中路由，其余不命中", () => {
    for (const url of [
      "https://www.douyin.com/video/7656056306591884643",
      "https://v.douyin.com/abcdef/",
      "https://www.iesdouyin.com/share/video/7656056306591884643/",
    ]) {
      expect(isDouyinUrl(url)).toBe(true);
    }
    for (const url of ["https://x.com/a/status/1", "https://mp.weixin.qq.com/s/abc", "not a url", "ftp://douyin.com/x"]) {
      expect(isDouyinUrl(url)).toBe(false);
    }
    expect(isDouyinShareLink("https://v.douyin.com/abc/")).toBe(true);
    expect(isDouyinShareLink("https://www.douyin.com/video/1")).toBe(false);
  });

  it("三种链接形态都抠得到 id；主页/合集抠不到", () => {
    expect(extractDouyinVideoId(`https://www.douyin.com/video/${VIDEO_ID}?from=web`)).toBe(VIDEO_ID);
    expect(extractDouyinVideoId(`https://www.douyin.com/user/MS4wLj?modal_id=${VIDEO_ID}`)).toBe(VIDEO_ID);
    expect(extractDouyinVideoId(`https://www.iesdouyin.com/share/video/${VIDEO_ID}/?region=CN`)).toBe(VIDEO_ID);
    expect(extractDouyinVideoId("https://www.douyin.com/user/MS4wLj")).toBeNull();
    expect(extractDouyinVideoId("https://example.com/video/123")).toBeNull();
  });
});

// --- 详情端点 ---

describe("justoneapi · get-video-detail", () => {
  it("happy path：嵌套里的 aweme_info 被找出来，字段与 stats 齐全", async () => {
    seenTokens = [];
    const video = await client().fetchVideoDetail(VIDEO_ID);

    expect(video).toEqual({
      videoId: VIDEO_ID,
      canonicalUrl: `https://www.douyin.com/video/${VIDEO_ID}`,
      desc: "做AI Agent整整一年了…\n这是文案第二行",
      authorNickname: "Ai-Agent",
      createTime: 1782823718,
      durationMs: 866934,
      stats: { likes: 135, comments: 11, collects: 132, shares: 29 },
    });
    // token 走 query 参数（vendor 契约），不是 header
    expect(seenTokens).toEqual(["test-token"]);
  });

  it("aweme_detail 键名同样认", async () => {
    expect((await client().fetchVideoDetail("detail-key")).desc).toContain("AI Agent");
  });

  it("响应缺 aweme_id 时回落请求用的 id", async () => {
    const video = await client().fetchVideoDetail("no-id");
    expect(video.videoId).toBe("no-id");
    expect(video.canonicalUrl).toBe("https://www.douyin.com/video/no-id");
  });

  it("响应里没有视频对象 → bad_response（可重试）", async () => {
    const err = await caught(() => client().fetchVideoDetail("no-video"));
    expect(err).toMatchObject({ errorCode: "justoneapi_bad_response", outcome: "failed" });
  });

  it("响应不是 JSON / 缺 code → bad_response", async () => {
    expect((await caught(() => client().fetchVideoDetail("not-json"))).errorCode).toBe("justoneapi_bad_response");
    expect((await caught(() => client().fetchVideoDetail("no-code"))).errorCode).toBe("justoneapi_bad_response");
  });
});

// --- 错误码矩阵（三态映射是验收项） ---

describe("justoneapi · 业务码 → 三态", () => {
  const matrix: Array<{ code: number; outcome: "blocked" | "failed" | "rejected" }> = [
    { code: 100, outcome: "blocked" },
    { code: 600, outcome: "blocked" },
    { code: 601, outcome: "blocked" },
    { code: 602, outcome: "blocked" },
    { code: 301, outcome: "failed" },
    { code: 302, outcome: "failed" },
    { code: 303, outcome: "failed" },
    { code: 500, outcome: "failed" },
    { code: 400, outcome: "rejected" },
  ];

  for (const { code, outcome } of matrix) {
    it(`code ${code} → ${outcome}`, async () => {
      const err = await caught(() => client().fetchVideoDetail(`code-${code}`));
      expect(err).toMatchObject({ errorCode: `justoneapi_${code}`, outcome });
      expect(classifyJustoneapiCode(code)).toBe(outcome);
    });
  }

  it("0 是成功；表外的码按可重试处理（判错方向偏重试）", async () => {
    expect(classifyJustoneapiCode(0)).toBe("ok");
    expect(classifyJustoneapiCode(9999)).toBe("failed");
    const err = await caught(() => client().fetchVideoDetail("code-9999"));
    expect(err).toMatchObject({ errorCode: "justoneapi_9999", outcome: "failed" });
  });

  it("错误消息带上游原文但不回显 token", async () => {
    const err = await caught(() => client().fetchVideoDetail("code-601"));
    expect(err.message).toContain("601");
    expect(err.message).toContain("上游说不行");
    expect(err.message).not.toContain("test-token");
  });
});

// --- HTTP 层 ---

describe("justoneapi · HTTP 层", () => {
  it("非 2xx 默认可重试；401/403 是凭证被拒 → blocked", async () => {
    expect(await caught(() => client().fetchVideoDetail("http-503"))).toMatchObject({
      errorCode: "justoneapi_http_503",
      outcome: "failed",
    });
    expect(await caught(() => client().fetchVideoDetail("http-401"))).toMatchObject({
      errorCode: "justoneapi_http_401",
      outcome: "blocked",
    });
  });

  it("超时 → failed（不是 rejected，重试还有救）", async () => {
    const err = await caught(() => client(80).fetchVideoDetail("slow"));
    expect(err).toMatchObject({ errorCode: "justoneapi_timeout", outcome: "failed" });
  });

  it("连不上 → failed", async () => {
    const dead = createJustoneapiClient("k", { baseUrl: "http://127.0.0.1:1", timeoutMs: 2_000 });
    expect(await caught(() => dead.fetchVideoDetail(VIDEO_ID))).toMatchObject({
      errorCode: "justoneapi_unreachable",
      outcome: "failed",
    });
  });
});

// --- 短链换标准链 ---

describe("justoneapi · share-url-transfer", () => {
  it("短链 → 标准抖音链，抠得到 videoId", async () => {
    const resolved = await client().resolveShareUrl("https://v.douyin.com/ok/");
    expect(resolved).toContain(`douyin.com/video/${VIDEO_ID}`);
    expect(extractDouyinVideoId(resolved)).toBe(VIDEO_ID);
  });

  it("解析出 iesdouyin 分享页也认（同属抖音域）", async () => {
    const resolved = await client().resolveShareUrl("https://v.douyin.com/ies/");
    expect(extractDouyinVideoId(resolved)).toBe(VIDEO_ID);
  });

  it("解析出非抖音域 → rejected（防开放跳转），且不回显整串地址", async () => {
    const err = await caught(() => client().resolveShareUrl("https://v.douyin.com/foreign/"));
    expect(err).toMatchObject({ errorCode: "justoneapi_foreign_redirect", outcome: "rejected" });
    expect(err.message).toContain("evil.example.com");
    expect(err.message).not.toContain("steal?next");
  });

  it("响应里没有地址 → bad_response", async () => {
    expect((await caught(() => client().resolveShareUrl("https://v.douyin.com/nourl/"))).errorCode).toBe(
      "justoneapi_bad_response",
    );
  });

  it("非 v.douyin.com 短链当场拒，不浪费一次调用", async () => {
    const err = await caught(() => client().resolveShareUrl(`https://www.douyin.com/video/${VIDEO_ID}`));
    expect(err).toMatchObject({ errorCode: "douyin_not_share_link", outcome: "rejected" });
  });

  it("短链路径的业务码同样落三态", async () => {
    expect(await caught(() => client().resolveShareUrl("https://v.douyin.com/code-100/"))).toMatchObject({
      errorCode: "justoneapi_100",
      outcome: "blocked",
    });
  });
});
