import { describe, it, expect, vi } from "vitest";
import { fetchX } from "./x.js";

function reply(tweets: unknown[]): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ tweets }), { status: 200 })) as unknown as typeof fetch;
}

describe("fetchX", () => {
  it("maps tweets → SourceItem: likeCount 当 heat, 文本截断, url 透传", async () => {
    const fetchImpl = reply([
      {
        text: "一条关于  AI  的高赞观点\n带换行",
        url: "https://x.com/a/status/1",
        author: { userName: "someone" },
        likeCount: 1200,
        retweetCount: 88,
      },
    ]);
    const items = await fetchX("AI", 10, { apiKey: "k", fetchImpl });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "x", heat: 1200, url: "https://x.com/a/status/1" });
    expect(items[0].title).toBe("一条关于 AI 的高赞观点 带换行"); // 空白压平
    expect(items[0].summary).toContain("@someone");
  });

  it("过滤掉赞数低于下限的碎碎念", async () => {
    const fetchImpl = reply([
      { text: "高赞", url: "https://x.com/a/1", likeCount: 500 },
      { text: "没人理", url: "https://x.com/a/2", likeCount: 3 },
    ]);
    const items = await fetchX("AI", 10, { apiKey: "k", fetchImpl });
    expect(items.map((i) => i.url)).toEqual(["https://x.com/a/1"]);
  });

  it("带 X-API-Key 头, queryType=Latest + min_faves 下限进查询", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ tweets: [] }), { status: 200 }));
    await fetchX("AI 工具", 10, { apiKey: "secret", fetchImpl: spy as unknown as typeof fetch });
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("queryType=Latest");
    expect(String(url)).toContain(encodeURIComponent("AI 工具 min_faves:50 -filter:replies -filter:retweets"));
    expect((init as RequestInit).headers).toMatchObject({ "X-API-Key": "secret" });
  });

  it("无 key → 抛错(不静默返回空,让上层归入 failedSources)", async () => {
    await expect(fetchX("AI", 10, { apiKey: "" })).rejects.toThrow(/key 未配置/);
  });

  it("HTTP 错 → 抛错", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchX("AI", 10, { apiKey: "k", fetchImpl })).rejects.toThrow(/401/);
  });
});
