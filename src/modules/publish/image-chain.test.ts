/**
 * 生图通道链:主通道挂了要跳下一家,而不是整条线停摆(2026-08 xiaojiu 空池三天的教训)。
 * 分类器是这里的要害——newcli 用 HTTP 400 + 中文文案报限流,按状态码分类会把它
 * 误判成永久错误直接放弃。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateImageViaChain, ImageChainError, type ImageProvider } from "./image-gen.js";
import { providerLabel } from "./wechat-mp.js";

const PNG = Buffer.from("fake-png-bytes");
const b64Body = JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] });

function res(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

const provider = (name: string): ImageProvider => ({
  name,
  baseUrl: `https://${name}.example/v1`,
  apiKey: "sk-test",
  model: "gpt-image-2",
});

afterEach(() => vi.restoreAllMocks());

describe("生图通道链", () => {
  it("第一家就出图时不碰后面的通道", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, b64Body));
    vi.stubGlobal("fetch", fetchMock);

    const out = await generateImageViaChain([provider("main"), provider("backup")], {
      prompt: "x",
      size: "16:9",
    });

    expect(out.provider).toBe("main");
    expect(out.usedFallback).toBe(false);
    expect(out.buf.toString()).toBe("fake-png-bytes");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("主通道账号池空(503)时降级到备用通道,并保留主通道的失败原因", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("main")
        ? res(503, '{"error":{"message":"No available compatible accounts"}}')
        : res(200, b64Body),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await generateImageViaChain([provider("main"), provider("backup")], {
      prompt: "x",
      size: "16:9",
      backoffMs: () => 0,
    });

    expect(out.provider).toBe("backup");
    expect(out.usedFallback).toBe(true);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].provider).toBe("main");
    expect(out.skipped[0].error).toContain("No available compatible accounts");
  });

  it("HTTP 400 + 中文限流文案要当成可降级,而不是永久性客户端错误", async () => {
    // newcli 实测响应:状态码 400,正文是纯文本中文,不是 JSON
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("main")
        ? res(400, "官方算力限制，请等待一段时间后再进行使用，如有问题可联系管理员")
        : res(200, b64Body),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await generateImageViaChain([provider("main"), provider("backup")], {
      prompt: "x",
      size: "16:9",
      backoffMs: () => 0,
    });

    expect(out.provider).toBe("backup");
    expect(out.usedFallback).toBe(true);
  });

  it("坏 key(401)不重试,但仍然降级到下一家——坏配置不该拖垮整条链", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("main") ? res(401, '{"message":"Invalid API key"}') : res(200, b64Body),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await generateImageViaChain([provider("main"), provider("backup")], { prompt: "x", size: "16:9" });

    expect(out.provider).toBe("backup");
    // 401 是不可重试的:主通道只该被打一次,不该退避重试 4 次
    const mainCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("main"));
    expect(mainCalls).toHaveLength(1);
  });

  it("200 但正文不是 JSON(中转的纯文本错误页)不崩,降级到下一家", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("main") ? res(200, "<html>502 Bad Gateway</html>") : res(200, b64Body),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await generateImageViaChain([provider("main"), provider("backup")], {
      prompt: "x",
      size: "16:9",
      backoffMs: () => 0,
    });

    expect(out.provider).toBe("backup");
  });

  it("全挂时抛 ImageChainError,并逐条列出每家的原因", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(503, "No available compatible accounts")));

    await expect(
      generateImageViaChain([provider("main"), provider("backup")], { prompt: "x", size: "16:9", backoffMs: () => 0 }),
    ).rejects.toThrow(ImageChainError);

    const err = await generateImageViaChain([provider("main"), provider("backup")], {
      prompt: "x",
      size: "16:9",
      backoffMs: () => 0,
    }).catch((e: unknown) => e as ImageChainError);

    expect(err.failures.map((f) => f.provider)).toEqual(["main", "backup"]);
    expect(err.message).toContain("main");
    expect(err.message).toContain("backup");
  });

  it("一条通道都没配时给出明确错误,而不是静默返回空图", async () => {
    await expect(generateImageViaChain([], { prompt: "x", size: "16:9" })).rejects.toThrow(ImageChainError);
  });
});

describe("即梦/Seedream 方言(ark)", () => {
  const captureBody = () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, b64Body));
    vi.stubGlobal("fetch", fetchMock);
    return () => JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body));
  };

  it("显式关掉水印——ark 默认 watermark=true,公众号配图不能带「AI 生成」角标", async () => {
    const body = captureBody();
    await generateImageViaChain(
      [{ name: "即梦", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "sk-x", dialect: "ark" }],
      { prompt: "x", size: "16:9" },
    );
    expect(body().watermark).toBe(false);
  });

  it("不发 quality/n(ark 不认这两个参数),尺寸走 Seedream 的枚举", async () => {
    const body = captureBody();
    await generateImageViaChain(
      [{ name: "即梦", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "sk-x", dialect: "ark" }],
      { prompt: "x", size: "16:9" },
    );
    const sent = body();
    expect(sent.quality).toBeUndefined();
    expect(sent.n).toBeUndefined();
    expect(sent.size).toBe("2560x1440");
    expect(sent.response_format).toBe("b64_json");
  });

  it("没写 model 时用 Seedream 默认模型,而不是 gpt-image-2", async () => {
    const body = captureBody();
    await generateImageViaChain(
      [{ name: "即梦", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "sk-x", dialect: "ark" }],
      { prompt: "x", size: "16:9" },
    );
    expect(String(body().model)).toContain("seedream");
  });

  it("openai 方言不受影响,仍然发 quality/n 和 gpt-image 尺寸", async () => {
    const body = captureBody();
    await generateImageViaChain([provider("main")], { prompt: "x", size: "16:9" });
    const sent = body();
    expect(sent.quality).toBe("high");
    expect(sent.n).toBe(1);
    expect(sent.size).toBe("1536x1024");
  });
});

describe("providerLabel", () => {
  it.each([
    ["https://api.xiaojiu.one/v1", "xiaojiu"],
    ["https://code.newcli.com/codex/v1", "newcli"],
    ["https://ark.cn-beijing.volces.com/api/v3", "volces"],
  ])("%s → %s", (url, expected) => {
    expect(providerLabel(url)).toBe(expected);
  });

  it("URL 不合法时退化成截断的原串,不抛错", () => {
    expect(providerLabel("not a url")).toBe("not a url");
  });
});
