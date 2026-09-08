import { describe, it, expect, vi } from "vitest";
import { fetchYouTubeSearch } from "./youtube-search.js";

interface VideoSpec {
  title: string;
  id: string;
  channel: string;
  views: number | null;
  length: string | null;
  published?: string;
}

/** 造一个 videoRenderer(结构照真实搜索页:播放量/时长都是 simpleText,直播没有 lengthText) */
function video(o: VideoSpec): Record<string, unknown> {
  const vr: Record<string, unknown> = {
    videoId: o.id,
    title: { runs: [{ text: o.title }] },
    ownerText: { runs: [{ text: o.channel }] },
    publishedTimeText: { simpleText: o.published ?? "3 days ago" },
  };
  if (o.views !== null) vr.viewCountText = { simpleText: `${o.views.toLocaleString("en-US")} views` };
  if (o.length !== null) vr.lengthText = { simpleText: o.length };
  return { videoRenderer: vr };
}

/** 把视频包进跟真实搜索页一样的多层容器,验证深搜而不是固定路径取 */
function searchPage(...videos: Array<Record<string, unknown>>): Response {
  const data = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: videos } }] },
        },
      },
    },
  };
  return new Response(
    `<!DOCTYPE html><html><body><script>var ytInitialData = ${JSON.stringify(data)};</script></body></html>`,
    { status: 200 },
  );
}

describe("fetchYouTubeSearch (关键词爆款模式)", () => {
  it("解析搜索页:标题/链接/播放量当 heat,summary 带频道、播放量、时间与检索词", async () => {
    const fetchImpl = vi.fn(async () =>
      searchPage(
        video({
          title: "Skills vs MCP vs RAG vs Memory",
          id: "X4FVEEegCbk",
          channel: "IBM Technology",
          views: 91832,
          length: "9:11",
          published: "4 days ago",
        }),
      ),
    ) as unknown as typeof fetch;

    const items = await fetchYouTubeSearch("AI agent", 10, { fetchImpl });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Skills vs MCP vs RAG vs Memory",
      url: "https://www.youtube.com/watch?v=X4FVEEegCbk",
      source: "youtube",
      heat: 91832,
    });
    expect(items[0].summary).toBe("IBM Technology · ▶91832 · 4 days ago · 搜「AI agent」");
  });

  it("URL 带 This week 过滤器和检索词:老片不该进来", async () => {
    const fetchImpl = vi.fn(async () => searchPage()) as unknown as typeof fetch;
    await fetchYouTubeSearch("AI agent", 10, { fetchImpl });

    const url = String(vi.mocked(fetchImpl).mock.calls[0][0]);
    expect(url).toContain("search_query=AI%20agent");
    expect(url).toContain("sp=EgIIAw%3D%3D");
  });

  it("播放量下限:没跑起来的小号噪音不进选材池", async () => {
    const fetchImpl = vi.fn(async () =>
      searchPage(
        video({ title: "爆款", id: "hot", channel: "大号", views: 90000, length: "9:11" }),
        video({ title: "小号自嗨", id: "cold", channel: "小号", views: 990, length: "19:59" }),
      ),
    ) as unknown as typeof fetch;

    const items = await fetchYouTubeSearch("AI agent", 10, { fetchImpl });
    expect(items.map((i) => i.title)).toEqual(["爆款"]);
  });

  it("下限可覆盖:调低阈值能把长尾放进来", async () => {
    const fetchImpl = vi.fn(async () =>
      searchPage(video({ title: "Agent Harness explained", id: "kai", channel: "Kai", views: 5512, length: "8:02" })),
    ) as unknown as typeof fetch;

    const items = await fetchYouTubeSearch("agent harness", 10, { fetchImpl, minViews: 5000 });
    expect(items.map((i) => i.title)).toEqual(["Agent Harness explained"]);
  });

  it("跳过 Shorts 与直播:竖屏切片和没有时长的不是选题材料", async () => {
    const fetchImpl = vi.fn(async () =>
      searchPage(
        video({ title: "正片", id: "full", channel: "频道", views: 80000, length: "12:02" }),
        video({ title: "Shorts", id: "short", channel: "频道", views: 500000, length: "0:42" }),
        video({ title: "直播中", id: "live", channel: "频道", views: 300000, length: null }),
      ),
    ) as unknown as typeof fetch;

    const items = await fetchYouTubeSearch("AI agent", 10, { fetchImpl });
    expect(items.map((i) => i.title)).toEqual(["正片"]);
  });

  it("拦漏网旧片:sp 过滤器偶尔在 shelf 里塞去年的片", async () => {
    const fetchImpl = vi.fn(async () =>
      searchPage(
        video({ title: "本周", id: "new", channel: "频道", views: 50000, length: "9:11", published: "2 days ago" }),
        video({ title: "去年", id: "old", channel: "频道", views: 900000, length: "9:11", published: "1 year ago" }),
        video({ title: "上月", id: "mid", channel: "频道", views: 800000, length: "9:11", published: "3 months ago" }),
      ),
    ) as unknown as typeof fetch;

    const items = await fetchYouTubeSearch("AI agent", 10, { fetchImpl });
    expect(items.map((i) => i.title)).toEqual(["本周"]);
  });

  it("按播放量降序:爆款排前面", async () => {
    const fetchImpl = vi.fn(async () =>
      searchPage(
        video({ title: "第三", id: "c", channel: "频道", views: 37469, length: "13:42" }),
        video({ title: "第一", id: "a", channel: "频道", views: 177415, length: "8:03" }),
        video({ title: "第二", id: "b", channel: "频道", views: 91832, length: "9:11" }),
      ),
    ) as unknown as typeof fetch;

    const items = await fetchYouTubeSearch("AI agent", 10, { fetchImpl });
    expect(items.map((i) => i.title)).toEqual(["第一", "第二", "第三"]);
  });

  it("时长解析支持时:分:秒", async () => {
    const fetchImpl = vi.fn(async () =>
      searchPage(video({ title: "长视频", id: "long", channel: "频道", views: 50000, length: "1:02:33" })),
    ) as unknown as typeof fetch;

    const items = await fetchYouTubeSearch("AI agent", 10, { fetchImpl });
    expect(items.map((i) => i.title)).toEqual(["长视频"]);
  });

  it("空关键词抛错:没有词等于抓全站首页噪音", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(fetchYouTubeSearch("   ", 10, { fetchImpl })).rejects.toThrow(/需要检索词/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("页面拉不到抛错:不静默降级成「本周没爆款」", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    await expect(fetchYouTubeSearch("AI agent", 10, { fetchImpl })).rejects.toThrow(/没拉到/);
  });

  it("页面结构变了(抠不出 ytInitialData)抛错,而不是当成空结果", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html><body>验证码页</body></html>", { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(fetchYouTubeSearch("AI agent", 10, { fetchImpl })).rejects.toThrow(/解析失败/);
  });

  it("非 2xx 退避重试:YouTube 零星节流不该让整轮空手而归", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("throttled", { status: 500 });
      return searchPage(video({ title: "重试后拿到", id: "ok", channel: "频道", views: 50000, length: "9:11" }));
    }) as unknown as typeof fetch;

    const items = await fetchYouTubeSearch("AI agent", 10, { fetchImpl });
    expect(calls).toBe(3);
    expect(items.map((i) => i.title)).toEqual(["重试后拿到"]);
  });
});
