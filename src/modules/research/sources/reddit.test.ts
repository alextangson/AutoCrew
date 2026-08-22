import { describe, it, expect, vi } from "vitest";

/**
 * token 缓存是模块级的,用例之间必须隔离——resetModules + 动态导入拿一份新的模块实例。
 */
async function loadReddit() {
  vi.resetModules();
  return import("./reddit.js");
}

function tokenRes(expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: "tok-1", token_type: "bearer", expires_in: expiresIn }), { status: 200 });
}

function listing(posts: Array<Record<string, unknown>>): Response {
  return new Response(
    JSON.stringify({ kind: "Listing", data: { children: posts.map((data) => ({ kind: "t3", data })) } }),
    { status: 200 },
  );
}

/** token 端点与数据端点分流的假 fetch */
function router(dataRes: () => Response, tokenResFn: () => Response = tokenRes) {
  return vi.fn(async (url: unknown) => (String(url).includes("access_token") ? tokenResFn() : dataRes()));
}

const CREDS = { clientId: "id", clientSecret: "secret" };

describe("fetchReddit (社区清单 + OAuth app-only)", () => {
  it("无凭据 → 抛错(不静默返回空,让上层归入 failedSources)", async () => {
    const { fetchReddit } = await loadReddit();
    await expect(fetchReddit(10, { clientId: "", clientSecret: "" })).rejects.toThrow(/凭据未配置/);
  });

  it("映射帖子:score 当 heat, url 补全域名, summary 带 r/sub 与互动数", async () => {
    const fetchImpl = router(() =>
      listing([
        {
          title: "Local model beats  GPT on\nthis task",
          permalink: "/r/LocalLLaMA/comments/abc/local_model/",
          subreddit: "LocalLLaMA",
          score: 420,
          num_comments: 88,
          selftext: "正文  被压成一行",
        },
      ]),
    ) as unknown as typeof fetch;
    const { fetchReddit } = await loadReddit();
    const items = await fetchReddit(10, { ...CREDS, fetchImpl });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Local model beats GPT on this task",
      url: "https://www.reddit.com/r/LocalLLaMA/comments/abc/local_model/",
      source: "reddit",
      heat: 420,
    });
    expect(items[0].summary).toBe("r/LocalLLaMA · ⬆420 · 💬88 正文 被压成一行");
  });

  it("过滤置顶帖与低分帖(沉底的自问自答不是选题材料)", async () => {
    const fetchImpl = router(() =>
      listing([
        { title: "置顶公告", permalink: "/r/a/1/", subreddit: "a", score: 900, stickied: true },
        { title: "低分帖", permalink: "/r/a/2/", subreddit: "a", score: 5 },
        { title: "够热的帖", permalink: "/r/a/3/", subreddit: "a", score: 200 },
      ]),
    ) as unknown as typeof fetch;
    const { fetchReddit } = await loadReddit();
    const items = await fetchReddit(10, { ...CREDS, fetchImpl });
    expect(items.map((i) => i.title)).toEqual(["够热的帖"]);
  });

  it("默认社区拼进一次请求(/r/a+b+c/top?t=day),带 Bearer 与自报家门的 UA", async () => {
    const fetchImpl = router(() => listing([])) as unknown as typeof fetch;
    const { fetchReddit, DEFAULT_SUBREDDITS } = await loadReddit();
    await fetchReddit(10, { ...CREDS, fetchImpl });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = calls.find((c) => !String(c[0]).includes("access_token"))!;
    expect(String(dataCall[0])).toContain(`/r/${DEFAULT_SUBREDDITS.join("+")}/top?t=day`);
    const headers = (dataCall[1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe("Bearer tok-1");
    expect(headers["user-agent"]).toContain("autocrew");
  });

  it("token 缓存复用:连拉两轮只取一次 token", async () => {
    const fetchImpl = router(() => listing([])) as unknown as typeof fetch;
    const { fetchReddit } = await loadReddit();
    await fetchReddit(10, { ...CREDS, fetchImpl });
    await fetchReddit(10, { ...CREDS, fetchImpl });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.filter((c) => String(c[0]).includes("access_token"))).toHaveLength(1);
    expect(calls.filter((c) => !String(c[0]).includes("access_token"))).toHaveLength(2);
  });

  it("token 已过期 → 重新取(不拿着死 token 硬发)", async () => {
    const fetchImpl = router(() => listing([]), () => tokenRes(0)) as unknown as typeof fetch;
    const { fetchReddit } = await loadReddit();
    await fetchReddit(10, { ...CREDS, fetchImpl });
    await fetchReddit(10, { ...CREDS, fetchImpl });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.filter((c) => String(c[0]).includes("access_token"))).toHaveLength(2);
  });

  it("取 token 401 → 抛错并带 status(凭据填错要看得见)", async () => {
    const fetchImpl = router(
      () => listing([]),
      () => new Response(JSON.stringify({ message: "Unauthorized", error: 401 }), { status: 401 }),
    ) as unknown as typeof fetch;
    const { fetchReddit } = await loadReddit();
    await expect(fetchReddit(10, { ...CREDS, fetchImpl })).rejects.toThrow(/HTTP 401/);
  });

  it("数据请求非 2xx(如被限流)→ 抛错,不吞成空", async () => {
    const fetchImpl = router(() => new Response("slow down", { status: 429 })) as unknown as typeof fetch;
    const { fetchReddit } = await loadReddit();
    await expect(fetchReddit(10, { ...CREDS, fetchImpl })).rejects.toThrow(/HTTP 429/);
  });
});
