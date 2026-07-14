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
  await fs.rm(testDir, { recursive: true, force: true });
});

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[OpenAI 发布新模型]]></title><link>https://a.com/1</link><pubDate>Thu, 11 Jun 2026 01:00:00 GMT</pubDate></item>
<item><title>美食探店指南 &amp; 测评</title><link>https://a.com/2</link><pubDate>Thu, 11 Jun 2026 02:00:00 GMT</pubDate></item>
</channel></rss>`;

describe("parseRssItems", () => {
  it("extracts title (CDATA + entity), link, pubDate", () => {
    const items = parseRssItems(RSS);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("OpenAI 发布新模型");
    expect(items[0].link).toBe("https://a.com/1");
    expect(items[1].title).toBe("美食探店指南 & 测评");
    expect(typeof items[1].publishedAt).toBe("string");
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
});

describe("refreshTopicRadar + cache + getTopicCandidates", () => {
  it("fetches all sources, tolerates per-source failure, writes cache", async () => {
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

describe("getCachedTopicCandidates", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-radarcache-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

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

  it("built-in defaults include disabled overseas adapters", async () => {
    const { loadRadarSources, OVERSEAS_KINDS } = await import("./topic-radar.js");
    const sources = await loadRadarSources(testDir);
    for (const kind of OVERSEAS_KINDS) {
      const s = sources.find((x) => x.kind === kind);
      expect(s, kind).toBeDefined();
      expect(s!.enabled).toBe(false);
    }
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

  it("overseas source without any derivable keyword lands in failedSources, not silence", async () => {
    const { saveRadarSources } = await import("./topic-radar.js");
    await saveRadarSources([
      { id: "hn", kind: "hackernews", name: "Hacker News", enabled: true, config: {} },
    ], testDir); // 无 profile → 无定位 → 无 ASCII 词
    const result = await refreshTopicRadar(testDir, globalThis.fetch, { overseasFetch: async () => [] });
    expect(result.failedSources).toContain("Hacker News");
  });
});
