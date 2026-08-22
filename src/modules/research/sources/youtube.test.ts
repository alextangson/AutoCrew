import { describe, it, expect, vi } from "vitest";
import { fetchYouTube, DEFAULT_YOUTUBE_CHANNELS } from "./youtube.js";

/** 造一条频道 feed 的 entry(结构照真实 videos.xml:link 在属性里、播放量在 media:statistics) */
function entry(o: { title: string; id: string; views: number; ageDays: number; desc?: string }): string {
  const published = new Date(Date.now() - o.ageDays * 24 * 3600_000).toISOString();
  return `<entry><id>yt:video:${o.id}</id><yt:videoId>${o.id}</yt:videoId>
    <title>${o.title}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${o.id}"/>
    <published>${published}</published><updated>${published}</updated>
    <media:group><media:title>${o.title}</media:title>
      <media:description>${o.desc ?? ""}</media:description>
      <media:community><media:starRating count="1" average="5.00"/><media:statistics views="${o.views}"/></media:community>
    </media:group></entry>`;
}

function feed(...entries: string[]): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"` +
      ` xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">` +
      `<title>某频道</title>${entries.join("")}</feed>`,
    { status: 200 },
  );
}

describe("fetchYouTube (频道清单模式)", () => {
  it("解析 Atom:标题/链接/播放量当 heat, summary 带频道名与简介", async () => {
    const fetchImpl = vi.fn(async () =>
      feed(entry({ title: "AI coding in 100 seconds", id: "v1", views: 120000, ageDays: 1, desc: "一句话  简介\n带换行" })),
    ) as unknown as typeof fetch;
    const items = await fetchYouTube(10, { channels: [{ id: "UC1", name: "Fireship" }], fetchImpl });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "AI coding in 100 seconds",
      url: "https://www.youtube.com/watch?v=v1",
      source: "youtube",
      heat: 120000,
    });
    expect(items[0].summary).toBe("Fireship · ▶120000 一句话 简介 带换行");
  });

  it("只留近 7 天:旧视频不是选题时效材料", async () => {
    const fetchImpl = vi.fn(async () =>
      feed(
        entry({ title: "上周的片", id: "old", views: 999999, ageDays: 30 }),
        entry({ title: "本周的片", id: "new", views: 100, ageDays: 2 }),
      ),
    ) as unknown as typeof fetch;
    const items = await fetchYouTube(10, { channels: [{ id: "UC1", name: "Fireship" }], fetchImpl });
    expect(items.map((i) => i.title)).toEqual(["本周的片"]);
  });

  it("每频道最多 2 条(高播放优先),多频道汇总按 heat 排序", async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes("UC_big")
        ? feed(
            entry({ title: "大号 A", id: "a", views: 500000, ageDays: 1 }),
            entry({ title: "大号 B", id: "b", views: 300000, ageDays: 1 }),
            entry({ title: "大号 C", id: "c", views: 200000, ageDays: 1 }),
          )
        : feed(entry({ title: "小号 A", id: "s", views: 400000, ageDays: 1 })),
    ) as unknown as typeof fetch;
    const items = await fetchYouTube(10, {
      channels: [{ id: "UC_big", name: "大号" }, { id: "UC_small", name: "小号" }],
      fetchImpl,
    });
    // 大号只进前两条(C 被截),汇总按播放量排序 → 小号插在中间
    expect(items.map((i) => i.title)).toEqual(["大号 A", "小号 A", "大号 B"]);
  });

  it("单频道 404(重试后仍挂)隔离,不拖垮其他频道", async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes("UC_dead")
        ? new Response("Not Found", { status: 404 })
        : feed(entry({ title: "活着的片", id: "ok", views: 100, ageDays: 1 })),
    ) as unknown as typeof fetch;
    const items = await fetchYouTube(10, {
      channels: [{ id: "UC_dead", name: "已关 feed" }, { id: "UC_ok", name: "正常" }],
      fetchImpl,
    });
    expect(items.map((i) => i.title)).toEqual(["活着的片"]);
  });

  it("零星 404 会重试一次:第二次 200 就照常收(边缘节点抖动不该丢掉整个频道)", async () => {
    let hits = 0;
    const fetchImpl = vi.fn(async () => {
      hits += 1;
      return hits === 1
        ? new Response("Not Found", { status: 404 })
        : feed(entry({ title: "重试拿到的片", id: "r", views: 777, ageDays: 1 }));
    }) as unknown as typeof fetch;
    const items = await fetchYouTube(10, { channels: [{ id: "UC1", name: "Fireship" }], fetchImpl });
    expect(hits).toBe(2);
    expect(items.map((i) => i.title)).toEqual(["重试拿到的片"]);
  });

  it("畸形 XML(返回 HTML)安全降级为空,不抛不炸", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html><body>nope</body></html>", { status: 200 })) as unknown as typeof fetch;
    const items = await fetchYouTube(10, { channels: [{ id: "UC1", name: "Fireship" }], fetchImpl });
    expect(items).toEqual([]);
  });

  it("全部频道都拉不到 → 抛错(本机不通要在 failedSources 里看得见,不静默变「今天没视频」)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(
      fetchYouTube(10, { channels: [{ id: "UC1", name: "A" }, { id: "UC2", name: "B" }], fetchImpl }),
    ).rejects.toThrow(/都没拉到/);
  });

  it("默认频道清单是验证过的 UC 频道 ID", () => {
    expect(DEFAULT_YOUTUBE_CHANNELS.length).toBeGreaterThanOrEqual(5);
    for (const ch of DEFAULT_YOUTUBE_CHANNELS) {
      expect(ch.id).toMatch(/^UC[\w-]{20,}$/);
      expect(ch.name.trim()).not.toBe("");
    }
  });
});
