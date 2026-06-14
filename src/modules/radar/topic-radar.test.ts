import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseRssItems,
  rankCandidates,
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
