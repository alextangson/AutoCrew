import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseRssItems,
  rankCandidates,
  rankCandidatesScored,
  refreshTopicRadar,
  loadTopicCache,
  getTopicCandidates,
  getCachedTopicCandidates,
  type RadarItem,
} from "./topic-radar.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-radar-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[OpenAI 发布新模型]]></title><link>https://a.com/1</link><pubDate>Thu, 11 Jun 2026 01:00:00 GMT</pubDate></item>
<item><title>美食探店指南 &amp; 测评 Nvidia&#039;s &#x2014;</title><link>https://a.com/2</link><pubDate>Thu, 11 Jun 2026 02:00:00 GMT</pubDate></item>
</channel></rss>`;

describe("parseRssItems", () => {
  it("extracts title (CDATA + entity), link, pubDate", () => {
    const items = parseRssItems(RSS);
    expect(items).toHaveLength(2);
    // 按发布时间新→旧
    expect(items[0].title).toBe("美食探店指南 & 测评 Nvidia's —");
    expect(items[1].title).toBe("OpenAI 发布新模型");
    expect(items[1].link).toBe("https://a.com/1");
    expect(items[1].publishedAt).toBe("2026-06-11T01:00:00.000Z");
  });

  it("parses Atom entries: alternate link over self, published/updated, escaped-HTML summary", () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Claude Code tips</title><link rel="self" href="https://s.net/api/1"/><link href="https://s.net/2026/Sep/1/"/>
<published>2026-09-01T10:00:00Z</published><summary type="html">&lt;p&gt;Hands-on notes&lt;/p&gt;</summary></entry>
<entry><title type="html">Only updated</title><link rel="alternate" type="text/html" href="https://s.net/2"/><updated>2026-09-02T10:00:00Z</updated></entry>
</feed>`;
    const items = parseRssItems(atom);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Only updated", link: "https://s.net/2", publishedAt: "2026-09-02T10:00:00.000Z" });
    expect(items[1]).toMatchObject({ link: "https://s.net/2026/Sep/1/", description: "Hands-on notes" });
  });

  it("keeps only the newest 30 items of a full-archive feed", () => {
    const body = Array.from({ length: 50 }, (_, i) =>
      `<item><title>t${i}</title><link>https://a.com/${i}</link><pubDate>${new Date(Date.UTC(2026, 0, 1 + i)).toUTCString()}</pubDate></item>`,
    ).join("");
    const items = parseRssItems(`<rss><channel>${body}</channel></rss>`);
    expect(items).toHaveLength(30);
    expect(items[0].title).toBe("t49");
    expect(items[29].title).toBe("t20");
  });

  it("undated feed keeps its own order when capped (head items survive)", () => {
    const body = Array.from({ length: 1000 }, (_, i) =>
      `<item><title>u${i}</title><link>https://a.com/u${i}</link></item>`,
    ).join("");
    const items = parseRssItems(`<rss><channel>${body}</channel></rss>`);
    expect(items.map((x) => x.title)).toEqual(Array.from({ length: 30 }, (_, i) => `u${i}`));
  });
});

describe("rankCandidates", () => {
  it("scores industry-token hits above non-hits", () => {
    const now = Date.now();
    const items: RadarItem[] = [
      { title: "城市露营装备清单", link: "l2", source: "36氪", publishedAt: new Date(now).toISOString() },
      { title: "AI技术全新突破", link: "l1", source: "36氪", publishedAt: new Date(now - 3600_000).toISOString() },
    ];
    const ranked = rankCandidates(items, "AI技术/科技博主", 10);
    expect(ranked[0].title).toBe("AI技术全新突破"); // 关键词 ×3 必须赢过更新鲜的非命中项
  });

  it("matches ASCII runs inside fused CJK-ASCII industry strings", () => {
    const now = new Date().toISOString();
    const items: RadarItem[] = [
      // 非命中项放第一位：排除稳定排序的假通过路径（与上一用例同款防护）
      { title: "城市露营装备清单", link: "l2", source: "36氪", publishedAt: now },
      { title: "OpenAI 发布新模型", link: "l1", source: "36氪", publishedAt: now },
    ];
    const ranked = rankCandidates(items, "AI技术博主", 10);
    expect(ranked[0].title).toBe("OpenAI 发布新模型");
  });

  it("does not treat AI inside Airbnb as an AI token hit", () => {
    const now = new Date().toISOString();
    const items: RadarItem[] = [
      { title: "Airbnb 分享 Kubernetes Sidecar 架构", link: "l1", source: "InfoQ", publishedAt: now },
      { title: "AI Agent 调试方法", link: "l2", source: "InfoQ", publishedAt: now },
    ];
    const ranked = rankCandidatesScored(items, "AI", 10);
    expect(ranked.find((r) => r.item.link === "l1")?.matchedTokens).toEqual([]);
    expect(ranked.find((r) => r.item.link === "l2")?.matchedTokens).toContain("AI");
  });

  it("caps at limit and prefers recent items on tie", () => {
    const items: RadarItem[] = Array.from({ length: 20 }, (_, i) => ({
      title: `科技新闻 ${i}`,
      link: `l${i}`,
      source: "36氪",
      publishedAt: new Date(Date.now() - i * 3600_000).toISOString(),
    }));
    const ranked = rankCandidates(items, "科技", 10);
    expect(ranked).toHaveLength(10);
    expect(ranked[0].title).toBe("科技新闻 0");
  });

  it("lifts a high-heat item above a cold same-source one (同源同鲜同命中 → 热度决高下)", () => {
    const now = new Date().toISOString();
    const items: RadarItem[] = [
      { title: "AI 冷门项目", link: "cold", source: "GitHub Trending", publishedAt: now, heat: 5 },
      { title: "AI 爆款项目", link: "hot", source: "GitHub Trending", publishedAt: now, heat: 9000 },
    ];
    const ranked = rankCandidatesScored(items, "AI", 10);
    expect(ranked[0].item.link).toBe("hot");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("judges heat in-source: HN 小 points 与 GitHub 大 stars 各按源内归一,不被绝对数字通吃", () => {
    const now = new Date().toISOString();
    const items: RadarItem[] = [
      { title: "AI 低星仓库", link: "gh-low", source: "GitHub Trending", publishedAt: now, heat: 100 },
      { title: "AI 万星仓库", link: "gh-high", source: "GitHub Trending", publishedAt: now, heat: 20000 },
      { title: "AI 热议讨论", link: "hn-top", source: "Hacker News", publishedAt: now, heat: 800 },
      { title: "AI 冷门讨论", link: "hn-low", source: "Hacker News", publishedAt: now, heat: 10 },
    ];
    const ranked = rankCandidatesScored(items, "AI", 10);
    // 两个源各自的登顶项并列最高,而非 GitHub 靠 stars 数字大通吃
    expect(["gh-high", "hn-top"]).toContain(ranked[0].item.link);
    const ghHigh = ranked.find((r) => r.item.link === "gh-high")!.score;
    const hnTop = ranked.find((r) => r.item.link === "hn-top")!.score;
    expect(hnTop).toBe(ghHigh);
    expect(ghHigh).toBeGreaterThan(ranked.find((r) => r.item.link === "gh-low")!.score);
  });
});

describe("rankCandidatesScored + 雷达关键词（focusKeywords 粗筛）", () => {
  const now = new Date().toISOString();
  const items: RadarItem[] = [
    { title: "Agent 编排框架实测", link: "l-agent", source: "Hacker News", publishedAt: now },
    { title: "部署工程师的一天", link: "l-industry", source: "36氪", publishedAt: now },
  ];
  // 定位是散文,切出来的是「部署工程师」这种在热榜标题里几乎不出现的长 token
  const INDUSTRY = "AI 技术,FDE 部署工程师";

  it("关键词非空时直接当 tokens 用,盖过定位切词", () => {
    const ranked = rankCandidatesScored(items, INDUSTRY, 10, ["Agent"]);
    expect(ranked.find((r) => r.item.link === "l-agent")?.matchedTokens).toEqual(["Agent"]);
    expect(ranked.find((r) => r.item.link === "l-industry")?.matchedTokens).toEqual([]);
    expect(ranked[0].item.link).toBe("l-agent");
  });

  it("关键词为空/全是单字 → 回落定位切词（其他用户零行为变化）", () => {
    for (const kws of [undefined, [], ["A", " "]]) {
      const ranked = rankCandidatesScored(items, INDUSTRY, 10, kws);
      // 回落路径命中的是定位切出来的长 token,而不是关键词
      expect(ranked.find((r) => r.item.link === "l-industry")?.matchedTokens).toContain("部署工程师");
    }
  });

  it("关键词含正则特殊字符不崩,且按字面匹配", () => {
    const tricky: RadarItem[] = [
      { title: "C++ 新标准落地", link: "cpp", source: "InfoQ", publishedAt: now },
      { title: "普通标题", link: "plain", source: "InfoQ", publishedAt: now },
    ];
    const ranked = rankCandidatesScored(tricky, INDUSTRY, 10, ["C++", "(*", "a|b"]);
    expect(ranked.find((r) => r.item.link === "cpp")?.matchedTokens).toEqual(["C++"]);
    expect(ranked.find((r) => r.item.link === "plain")?.matchedTokens).toEqual([]);
  });
});

describe("refreshTopicRadar + cache + getTopicCandidates", () => {
  beforeEach(async () => {
    // Cache tests inject RSS fetch only. Default overseas adapters use their own
    // network clients, so explicitly scope these fixtures to the mocked source.
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([
      { id: "36kr", kind: "rss", name: "36氪", enabled: true, config: { url: "https://36kr.com/feed" } },
    ], testDir);
  });

  it("fetches all sources, tolerates per-source failure, writes cache", async () => {
    // 固定两个 RSS 源,与「默认开哪些海外源」解耦——本用例只测 RSS 单源失败的容错
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([
      { id: "36kr", kind: "rss", name: "36氪", enabled: true, config: { url: "https://36kr.com/feed" } },
      { id: "ifanr", kind: "rss", name: "爱范儿", enabled: true, config: { url: "https://www.ifanr.com/feed" } },
    ], testDir);
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes("36kr")) return new Response(RSS, { status: 200 });
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await refreshTopicRadar(testDir, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.itemCount).toBe(2);
    expect(result.failedSources).toEqual(["爱范儿"]);

    const cache = await loadTopicCache(testDir);
    expect(cache?.items).toHaveLength(2);
    expect(typeof cache?.fetchedAt).toBe("string");
  });

  it("RSS 返回 HTML(解析 0 条) → 该源进 failedSources,不静默当成「今天没新闻」", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([
      { id: "dead", kind: "rss", name: "36氪", enabled: true, config: { url: "https://36kr.com/feed" } },
      { id: "ok", kind: "rss", name: "爱范儿", enabled: true, config: { url: "https://www.ifanr.com/feed" } },
    ], testDir);
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes("36kr")
        ? new Response("<!doctype html><html><body>404</body></html>", { status: 200 })
        : new Response(RSS, { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await refreshTopicRadar(testDir, fetchImpl);
    expect(result.failedSources).toEqual(["36氪"]);
    expect(result.itemCount).toBe(2); // 活着的源照常入缓存
  });

  it("getTopicCandidates serves from fresh cache without fetching", async () => {
    const fetchImpl = vi.fn(async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
    await refreshTopicRadar(testDir, fetchImpl);
    fetchImpl.mockClear();

    const candidates = await getTopicCandidates("AI技术", testDir, fetchImpl);
    expect(candidates.length).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled(); // 新鲜缓存不触发网络
  });

  it("getTopicCandidates refreshes when cache is missing", async () => {
    const fetchImpl = vi.fn(async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
    const candidates = await getTopicCandidates("科技", testDir, fetchImpl);
    expect(fetchImpl).toHaveBeenCalled();
    expect(candidates.length).toBeGreaterThan(0);
  });
});

describe("refreshTopicRadarIfStale (TTL 门:自动触发不烧付费源)", () => {
  // 海外源不走注入的 fetchImpl(它们在 registry 里直接用 global fetch),这里必须显式挡掉,
  // 否则这两条测的是「本机能不能连上 HN/YouTube」,而不是 TTL 门本身。
  const noOverseas = { overseasFetch: async () => [] };

  it("缓存新鲜 → 跳过,不打任何源", async () => {
    const { refreshTopicRadarIfStale, refreshTopicRadar } = await import("./topic-radar.js");
    const fetchImpl = vi.fn(async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
    await refreshTopicRadar(testDir, fetchImpl, noOverseas); // 先真刷一轮,缓存新鲜
    fetchImpl.mockClear();

    const r = await refreshTopicRadarIfStale(testDir, fetchImpl, noOverseas);
    expect(r.skippedFresh).toBe(true);
    expect(r.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled(); // 一个源都没打
  });

  it("缓存过期 → 正常刷新", async () => {
    const { refreshTopicRadarIfStale } = await import("./topic-radar.js");
    await fs.writeFile(
      path.join(testDir, "topic-radar.json"),
      JSON.stringify({ fetchedAt: new Date(Date.now() - 7 * 3600_000).toISOString(), items: [] }), // 7h 前,超 6h TTL
    );
    const fetchImpl = vi.fn(async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
    const r = await refreshTopicRadarIfStale(testDir, fetchImpl, noOverseas);
    expect(r.skippedFresh).toBe(false);
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe("getCachedTopicCandidates", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-radarcache-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  async function seedCache(items: Array<{ title: string; link: string; source: string; publishedAt: string }>) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "topic-radar.json"),
      JSON.stringify({ fetchedAt: "2026-06-14T00:00:00.000Z", items }), "utf-8");
  }

  it("ranks cached items by industry without any network call", async () => {
    const fetchSpy = vi.fn();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await seedCache([
        { title: "AI 大模型推理成本下降", link: "http://a", source: "36氪", publishedAt: "2026-06-14T00:00:00.000Z" },
        { title: "今日午餐吃什么", link: "http://b", source: "x", publishedAt: "2026-06-14T00:00:00.000Z" },
      ]);
      const res = await getCachedTopicCandidates("AI 技术", dir, 10);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].title).toContain("AI");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns [] when no cache exists (no network)", async () => {
    const fetchSpy = vi.fn();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      expect(await getCachedTopicCandidates("AI 技术", dir, 10)).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("user-configurable sources (IA v4.2 §A1)", () => {
  it("loadRadarSources falls back to built-ins without a user file", async () => {
    const { loadRadarSources } = await import("./topic-radar.js");
    const sources = await loadRadarSources(testDir);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((s) => s.name === "36氪")).toBe(true);
  });

  it("saveRadarSources persists and fully takes over (built-ins gone)", async () => {
    const { loadRadarSources, saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources(
      [{ id: "", name: "量子位", type: "rss", url: "https://www.qbitai.com/feed", tracks: [] }],
      testDir,
    );
    const sources = await loadRadarSources(testDir);
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe("量子位");
    expect(sources[0].id).toBeTruthy(); // 自动生成 id
  });

  it("saveRadarSources rejects bad urls and empty names; dedupes by url", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    await expect(saveRadarSources([{ id: "", name: "x", type: "rss", url: "ftp://bad", tracks: [] }], testDir))
      .rejects.toThrow(/http/);
    await expect(saveRadarSources([{ id: "", name: "", type: "rss", url: "https://a.com/f", tracks: [] }], testDir))
      .rejects.toThrow(/名称/);
    const saved = await saveRadarSources(
      [
        { id: "", name: "A", type: "rss", url: "https://same.com/feed", tracks: [] },
        { id: "", name: "B", type: "rss", url: "https://same.com/feed", tracks: [] },
      ],
      testDir,
    );
    expect(saved).toHaveLength(1);
  });

  it("refreshTopicRadar pulls from the user-configured source list", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources(
      [{ id: "", name: "自定义源", type: "rss", url: "https://custom.example/feed", tracks: [] }],
      testDir,
    );
    const seen = [];
    const fetchImpl = (async (url) => {
      seen.push(String(url));
      return new Response(RSS, { status: 200 });
    });
    const result = await refreshTopicRadar(testDir, fetchImpl);
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["https://custom.example/feed"]); // 只打用户的源,内置不再出现
  });
});

describe("unified intel layer v2 (adapter kinds + migration)", () => {
  it("migrates v1 user file (type+url) to v2 shape on load", async () => {
    await fs.writeFile(path.join(testDir, "radar-sources.json"), JSON.stringify({
      version: 1,
      sources: [{ id: "qb", name: "量子位", type: "rss", url: "https://www.qbitai.com/feed", tracks: [] }],
    }));
    const { loadRadarSources } = await import("./topic-radar.js");
    const sources = await loadRadarSources(testDir);
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("rss");
    expect(sources[0].enabled).toBe(true);
    expect(sources[0].config.url).toBe("https://www.qbitai.com/feed");
  });

  it("built-in defaults ship high-signal overseas adapters on, research ones off", async () => {
    const { loadRadarSources } = await import("./topic-radar.js");
    const sources = await loadRadarSources(testDir);
    const enabledOf = (kind: string) => sources.find((x) => x.kind === kind)?.enabled;
    // HN/GitHub 带真实热度、PH 给新品发布 → 默认开;arXiv/HF 是研究产物,选题张力低 → 默认关
    expect(enabledOf("hackernews")).toBe(true);
    expect(enabledOf("github")).toBe(true);
    expect(enabledOf("producthunt")).toBe(true);
    expect(enabledOf("arxiv")).toBe(false);
    expect(enabledOf("huggingface")).toBe(false);
    // 自带凭据/依赖直连的清单型源默认关,等用户配好再开(与 x 同待遇)
    expect(enabledOf("youtube")).toBe(false);
    expect(enabledOf("reddit")).toBe(false);
  });

  it("scan pulls enabled overseas adapters with keyword derived from positioning", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    const { saveProfile } = await import("../profile/creator-profile.js");
    const now = new Date().toISOString();
    await saveProfile({
      industry: "AI 效率工具", platforms: [], audiencePersona: null, writingRules: [],
      styleBoundaries: { never: [], always: [] }, competitorAccounts: [], performanceHistory: [],
      styleCalibrated: true, createdAt: now, updatedAt: now,
    }, testDir);
    await saveRadarSources([
      { id: "hn", kind: "hackernews", name: "Hacker News", enabled: true, config: {} },
      { id: "off", kind: "github", name: "GitHub", enabled: false, config: {} },
    ], testDir);

    const calls = [];
    const overseasFetch = async (kind, keyword) => {
      calls.push({ kind, keyword });
      return [{ title: "HN item", url: "https://hn.example/1" }];
    };
    const result = await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ kind: "hackernews", keyword: "AI" }]); // enabled 才扫;keyword 从定位派生;disabled 不扫
    const cache = await loadTopicCache(testDir);
    expect(cache.items.some((i) => i.title === "HN item")).toBe(true);
  });

  it("海外源检索词优先取雷达关键词,再回落定位", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    const { saveProfile } = await import("../profile/creator-profile.js");
    const now = new Date().toISOString();
    await saveProfile({
      industry: "AI 效率工具", focusKeywords: ["工程化", "Agent"], platforms: [], audiencePersona: null,
      writingRules: [], styleBoundaries: { never: [], always: [] }, competitorAccounts: [],
      performanceHistory: [], styleCalibrated: true, createdAt: now, updatedAt: now,
    }, testDir);
    await saveRadarSources([
      { id: "hn", kind: "hackernews", name: "Hacker News", enabled: true, config: {} },
    ], testDir);

    const calls: Array<{ kind: string; keyword: string }> = [];
    const overseasFetch = async (kind: string, keyword: string) => {
      calls.push({ kind, keyword });
      return [{ title: "HN item", url: "https://hn.example/1" }];
    };
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch });
    // 「工程化」无 ASCII 可用 → 跳到下一个关键词 "Agent";没有关键词时才回落定位的 "AI"
    expect(calls).toEqual([{ kind: "hackernews", keyword: "Agent" }]);
  });

  it("清单型源(X/YouTube/Reddit)不吃检索词:没定位也照常扫,不因缺 keyword 进 failedSources", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([
      { id: "x", kind: "x", name: "X", enabled: true, config: {} },
      { id: "yt", kind: "youtube", name: "YouTube", enabled: true, config: {} },
      { id: "rd", kind: "reddit", name: "Reddit", enabled: true, config: {} },
    ], testDir); // 无 profile → 派生不出任何检索词

    const calls: string[] = [];
    const overseasFetch = async (kind: string) => {
      calls.push(kind);
      return [{ title: `${kind} item`, url: `https://${kind}.example/1` }];
    };
    const result = await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch });

    expect(calls.sort()).toEqual(["reddit", "x", "youtube"]);
    expect(result.failedSources).toEqual([]);
    expect(result.itemCount).toBe(3);
  });

  it("overseas source without any derivable keyword lands in failedSources, not silence", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([
      { id: "hn", kind: "hackernews", name: "Hacker News", enabled: true, config: {} },
    ], testDir); // 无 profile → 无定位 → 无 ASCII 词
    const result = await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: async () => [] });
    expect(result.failedSources).toContain("Hacker News");
  });
});

describe("per-source minIntervalHours (付费源一天一次)", () => {
  async function setup() {
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([
      { id: "x", kind: "x", name: "X", enabled: true, config: { minIntervalHours: 24 } },
      { id: "yt", kind: "youtube", name: "YouTube", enabled: true, config: {} },
    ], testDir);
  }
  const counting = (calls: string[], fail?: string) => async (kind: string) => {
    calls.push(kind);
    if (kind === fail) throw new Error("boom");
    return [{ title: `${kind} ${calls.length}`, url: `https://${kind}.example/${calls.length}` }];
  };

  it("within the interval: X is not re-fetched and its last items are carried over", async () => {
    await setup();
    const calls: string[] = [];
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: counting(calls) });
    const first = (await loadTopicCache(testDir))!.items.find((i) => i.source === "X")!;
    calls.length = 0;
    const r = await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: counting(calls) });
    expect(calls).toEqual(["youtube"]);
    expect(r.itemCount).toBe(2);
    expect((await loadTopicCache(testDir))!.items.find((i) => i.source === "X")).toEqual(first);
  });

  it("after the interval: X is fetched again", async () => {
    await setup();
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: counting([]) });
    const cache = (await loadTopicCache(testDir))!;
    cache.sourceFetchedAt!.x = new Date(Date.now() - 25 * 3600_000).toISOString();
    await fs.writeFile(path.join(testDir, "topic-radar.json"), JSON.stringify(cache));
    const calls: string[] = [];
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: counting(calls) });
    expect(calls.sort()).toEqual(["x", "youtube"]);
  });

  it("a failed X fetch records no timestamp, so the next round retries", async () => {
    await setup();
    const r1 = await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: counting([], "x") });
    expect(r1.failedSources).toEqual(["X"]);
    expect((await loadTopicCache(testDir))!.sourceFetchedAt?.x).toBeUndefined();
    const calls: string[] = [];
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: counting(calls) });
    expect(calls).toContain("x");
  });

  it("X alone returning nothing still records its clock (no other source to force a cache write)", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([{ id: "x", kind: "x", name: "X", enabled: true, config: { minIntervalHours: 24 } }], testDir);
    const calls: string[] = [];
    const empty = async (kind: string) => { calls.push(kind); return []; };
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: empty });
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: empty });
    expect(calls).toEqual(["x"]);
  });

  it("renaming a source keeps its carried items (matched by id, not display name)", async () => {
    await setup();
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: counting([]) });
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([
      { id: "x", kind: "x", name: "X 关注清单", enabled: true, config: { minIntervalHours: 24 } },
      { id: "yt", kind: "youtube", name: "YouTube", enabled: true, config: {} },
    ], testDir);
    const calls: string[] = [];
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: counting(calls) });
    expect(calls).toEqual(["youtube"]);
    expect((await loadTopicCache(testDir))!.items.filter((i) => i.sourceId === "x")).toHaveLength(1);
  });

  it("a successful but empty X fetch still counts, so a quiet day doesn't trigger paid rescans", async () => {
    await setup();
    await refreshTopicRadar(testDir, globalThis.fetch, {
      overseasFetch: async (kind: string) => (kind === "x" ? [] : [{ title: "yt", url: "https://yt/1" }]),
    });
    const calls: string[] = [];
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: counting(calls) });
    expect(calls).toEqual(["youtube"]);
  });
});

describe("per-source interval: clock and TTL bookkeeping", () => {
  it("a temporarily disabled X keeps its clock, so re-enabling it within 24h does not re-fetch", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    const x = { id: "x", kind: "x" as const, name: "X", config: { minIntervalHours: 24 } };
    const yt = { id: "yt", kind: "youtube" as const, name: "YouTube", enabled: true, config: {} };
    const calls: string[] = [];
    const fetcher = async (kind: string) => { calls.push(kind); return [{ title: kind, url: `https://${kind}/${calls.length}` }]; };
    await saveRadarSources([{ ...x, enabled: true }, yt], testDir);
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: fetcher });
    await saveRadarSources([{ ...x, enabled: false }, yt], testDir);
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: fetcher });
    await saveRadarSources([{ ...x, enabled: true }, yt], testDir);
    calls.length = 0;
    await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: fetcher });
    expect(calls).toEqual(["youtube"]);
  });

  it("a round that only carried X (everything else failed) does not reset the 6h TTL", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([
      { id: "x", kind: "x", name: "X", enabled: true, config: { minIntervalHours: 24 } },
      { id: "yt", kind: "youtube", name: "YouTube", enabled: true, config: {} },
    ], testDir);
    await refreshTopicRadar(testDir, globalThis.fetch, {
      overseasFetch: async (kind: string) => [{ title: kind, url: `https://${kind}/1` }],
    });
    const cache = (await loadTopicCache(testDir))!;
    const old = new Date(Date.now() - 7 * 3600_000).toISOString();
    cache.fetchedAt = old;
    await fs.writeFile(path.join(testDir, "topic-radar.json"), JSON.stringify(cache));
    const r = await refreshTopicRadar(testDir, globalThis.fetch, {
      overseasFetch: async () => { throw new Error("down"); },
    });
    expect(r.failedSources).toEqual(["YouTube"]);
    expect((await loadTopicCache(testDir))!.fetchedAt).toBe(old);
  });
});
