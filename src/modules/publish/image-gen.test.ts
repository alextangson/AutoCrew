/**
 * image-gen.test.ts — 原生中转生图（PRD-v4 §9 去桥化第一步）
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateImageViaRelay, resolveRelaySize } from "./image-gen.js";

const REQ = {
  baseUrl: "https://relay.example/v1",
  apiKey: "sk-test",
  model: "gpt-image-2",
  prompt: "一张测试图",
  size: "16:9",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resolveRelaySize", () => {
  it("比例简写映射到 gpt-image 合法尺寸;非法输入报错", () => {
    expect(resolveRelaySize("16:9")).toBe("1536x1024");
    expect(resolveRelaySize("9:16")).toBe("1024x1536");
    expect(resolveRelaySize("1024x1024")).toBe("1024x1024");
    expect(() => resolveRelaySize("21:9")).toThrow(/不支持的图片尺寸/);
  });
});

describe("generateImageViaRelay", () => {
  it("b64 响应 → 解码为字节;请求体带 model/size/quality,端点为 /images/generations", async () => {
    const png = Buffer.from("fake-png-bytes");
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }));
    vi.stubGlobal("fetch", fetchMock);

    const buf = await generateImageViaRelay(REQ);

    expect(buf.equals(png)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example/v1/images/generations");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "gpt-image-2", size: "1536x1024", quality: "high", n: 1 });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("url 响应 → 二次下载图片字节(dm-fox 类中转)", async () => {
    const png = Buffer.from("url-png-bytes");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: "https://cdn.example/img.png" }] }))
      .mockResolvedValueOnce(new Response(png));
    vi.stubGlobal("fetch", fetchMock);

    const buf = await generateImageViaRelay(REQ);

    expect(buf.equals(png)).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe("https://cdn.example/img.png");
  });

  it("首次 HTTP 错误 → 4s 退避后重试成功", async () => {
    vi.useFakeTimers();
    const png = Buffer.from("retry-png");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: png.toString("base64") }] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = generateImageViaRelay(REQ);
    await vi.advanceTimersByTimeAsync(4_000);
    const buf = await promise;

    expect(buf.equals(png)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("两次都失败 → 抛出含真实原因的错误(禁止静默)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = generateImageViaRelay(REQ).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(4_000);
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/生图失败.*HTTP 500/s);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("空 data(无 b64 也无 url)→ 报限流/排队人话错误", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = generateImageViaRelay(REQ).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(4_000);
    const err = await promise;

    expect((err as Error).message).toMatch(/empty image data/);
  });
});
