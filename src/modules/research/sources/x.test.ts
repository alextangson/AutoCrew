import { describe, it, expect, vi } from "vitest";
import { fetchX, DEFAULT_X_ACCOUNTS } from "./x.js";

/** last_tweets 响应形状:tweets 在 data.tweets 下 */
function userReply(tweets: unknown[]): Response {
  return new Response(JSON.stringify({ status: "success", data: { pin_tweet: null, tweets } }), { status: 200 });
}

describe("fetchX (关注清单模式)", () => {
  it("按账号拉原创帖:likeCount 当 heat, 过滤转推, 文本截断, summary 带 handle", async () => {
    const fetchImpl = vi.fn(async () =>
      userReply([
        { text: "RT @someone: 别人的转推", url: "https://x.com/a/1", likeCount: 9999 },
        { text: "一条有共识度的原创观点\n带换行", url: "https://x.com/a/2", likeCount: 800, retweetCount: 40 },
        { text: "随手闲聊", url: "https://x.com/a/3", likeCount: 5 },
      ]),
    ) as unknown as typeof fetch;
    const items = await fetchX(20, { apiKey: "k", accounts: ["someone"], fetchImpl });
    expect(items).toHaveLength(1); // 转推剔除, 低赞(<30)过滤
    expect(items[0]).toMatchObject({ source: "x", heat: 800, url: "https://x.com/a/2" });
    expect(items[0].title).toBe("一条有共识度的原创观点 带换行");
    expect(items[0].summary).toContain("@someone");
  });

  it("每账号最多取 2 条(高赞优先), 防大号刷屏", async () => {
    const fetchImpl = vi.fn(async () =>
      userReply([
        { text: "赞100", url: "u1", likeCount: 100 },
        { text: "赞300", url: "u3", likeCount: 300 },
        { text: "赞200", url: "u2", likeCount: 200 },
      ]),
    ) as unknown as typeof fetch;
    const items = await fetchX(20, { apiKey: "k", accounts: ["big"], fetchImpl });
    expect(items.map((i) => i.heat)).toEqual([300, 200]); // 取最高两条
  });

  it("多账号汇总并按 heat 排序", async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes("alice")
        ? userReply([{ text: "alice 帖", url: "ua", likeCount: 50 }])
        : userReply([{ text: "bob 帖", url: "ub", likeCount: 900 }]),
    ) as unknown as typeof fetch;
    const items = await fetchX(20, { apiKey: "k", accounts: ["alice", "bob"], fetchImpl });
    expect(items.map((i) => i.title)).toEqual(["bob 帖", "alice 帖"]);
  });

  it("单账号失败(网络/非200)隔离, 不拖垮其他账号", async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes("bad")) return new Response("nope", { status: 500 });
      return userReply([{ text: "good 帖", url: "ug", likeCount: 60 }]);
    }) as unknown as typeof fetch;
    const items = await fetchX(20, { apiKey: "k", accounts: ["bad", "good"], fetchImpl });
    expect(items.map((i) => i.title)).toEqual(["good 帖"]);
  });

  it("无 key → 抛错(不静默返回空,让上层归入 failedSources)", async () => {
    await expect(fetchX(20, { apiKey: "" })).rejects.toThrow(/key 未配置/);
  });

  it("默认关注清单含 FDE 与 AI 前沿代表账号", () => {
    expect(DEFAULT_X_ACCOUNTS).toContain("karpathy");
    expect(DEFAULT_X_ACCOUNTS).toContain("garrytan");
    expect(DEFAULT_X_ACCOUNTS.length).toBeGreaterThanOrEqual(10);
  });
});
