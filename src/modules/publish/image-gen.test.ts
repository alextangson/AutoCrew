/**
 * image-gen.test.ts — 原生中转生图（PRD-v4 §9 去桥化第一步;V5.6.1 +edits 参考图）
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateImageViaRelay, editImageViaRelay, RelayEditUnsupportedError, resolveRelaySize } from "./image-gen.js";

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

  it("瞬时错误(429) → 退避后重试成功", async () => {
    vi.useFakeTimers();
    const png = Buffer.from("retry-png");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: png.toString("base64") }] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = generateImageViaRelay(REQ);
    await vi.advanceTimersByTimeAsync(5_000); // 首次退避 5s
    const buf = await promise;

    expect(buf.equals(png)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("瞬时错误(503/账号池空)持续到用尽重试 → 抛真实原因(禁止静默),共 4 次", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("no available accounts", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = generateImageViaRelay(REQ).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(35_000); // 5s+10s+20s 退避全推进
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/已重试 4 次.*HTTP 503/s);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("4xx(400 坏请求)→ 快速失败,不空转重试", async () => {
    const fetchMock = vi.fn(async () => new Response("bad prompt", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateImageViaRelay(REQ)).rejects.toThrow(/不可重试|HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("空 data(无 b64 也无 url)→ 重试用尽后报限流/排队人话错误", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = generateImageViaRelay(REQ).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(35_000);
    const err = await promise;

    expect((err as Error).message).toMatch(/empty image data/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("editImageViaRelay(V5.6.1 参考图/人物一致性)", () => {
  let dir: string;
  let refPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-imageedit-"));
    refPath = path.join(dir, "me.png");
    await fs.writeFile(refPath, Buffer.from("ref-photo-bytes"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const EDIT_REQ = { ...REQ, size: "3:4", referenceImagePaths: [] as string[] };

  it("multipart 走 /images/edits:字段与参考图齐全,key 只在 header", async () => {
    const png = Buffer.from("edit-png-bytes");
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }));
    vi.stubGlobal("fetch", fetchMock);

    const buf = await editImageViaRelay({ ...EDIT_REQ, referenceImagePaths: [refPath] });

    expect(buf.equals(png)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example/v1/images/edits");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("size")).toBe("1024x1536");
    expect(form.get("quality")).toBe("high");
    const image = form.get("image[]") as File;
    expect(image?.name).toBe("me.png");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(form.get("api_key")).toBeNull();
  });

  it("4xx → RelayEditUnsupportedError,不重试(调用方降级 generations)", async () => {
    const fetchMock = vi.fn(async () => new Response("no such endpoint", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(editImageViaRelay({ ...EDIT_REQ, referenceImagePaths: [refPath] })).rejects.toThrow(RelayEditUnsupportedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx 退避重试用尽后抛普通错误(非 Unsupported)——空参考图列表,退避走纯 fake-timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    // 空 refs 绕开真实 fs 读取:fake timers 与线程池 IO 混用会让退避推进不确定
    const promise = editImageViaRelay({ ...EDIT_REQ, referenceImagePaths: [] }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(35_000);
    const err = await promise;

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RelayEditUnsupportedError);
    expect((err as Error).message).toMatch(/参考图生图失败/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("429 属限流 → 退避重试成功,不当作 Unsupported 降级", async () => {
    vi.useFakeTimers();
    const png = Buffer.from("edit-retry-png");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: png.toString("base64") }] }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = editImageViaRelay({ ...EDIT_REQ, referenceImagePaths: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    const buf = await promise;

    expect(buf.equals(png)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
