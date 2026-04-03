import { describe, it, expect, vi } from "vitest";
import { buildMultiDimensionQueries, createWebSearchCollector } from "./web-search.js";
import type { SearchResult } from "./web-search.js";

describe("buildMultiDimensionQueries", () => {
  it("generates 4+ queries with expected keywords", () => {
    const queries = buildMultiDimensionQueries("AI Agent", "科技", ["小红书", "抖音"]);
    expect(queries.length).toBeGreaterThanOrEqual(4);
    // Every query should contain the keyword
    for (const q of queries) {
      expect(q).toContain("AI Agent");
    }
  });

  it("includes dimension-specific terms", () => {
    const queries = buildMultiDimensionQueries("ChatGPT", "AI", []);
    const joined = queries.join(" ");
    expect(joined).toContain("行业动态");
    expect(joined).toContain("争议");
    expect(joined).toContain("数据报告");
    expect(joined).toContain("实操教程");
    expect(joined).toContain("最新趋势");
  });

  it("adds platform-specific queries", () => {
    const queries = buildMultiDimensionQueries("LLM", "科技", ["B站"]);
    expect(queries.some((q) => q.includes("B站"))).toBe(true);
  });
});

describe("createWebSearchCollector", () => {
  it("collects items from search results", async () => {
    const mockResults: SearchResult[] = [
      { title: "Test Article", url: "https://example.com/1", snippet: "A test" },
      { title: "Another Article", url: "https://example.com/2", snippet: "Another" },
    ];
    const searchFn = vi.fn().mockResolvedValue(mockResults);
    const collector = createWebSearchCollector(searchFn);

    const result = await collector.collect({
      keywords: ["test"],
      industry: "科技",
      platforms: [],
    });

    expect(result.source).toBe("web_search");
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].source).toBe("web_search");
    expect(result.errors).toEqual([]);
  });

  it("deduplicates by URL", async () => {
    const sameResult: SearchResult[] = [
      { title: "Dup", url: "https://example.com/same", snippet: "dup" },
    ];
    const searchFn = vi.fn().mockResolvedValue(sameResult);
    const collector = createWebSearchCollector(searchFn);

    const result = await collector.collect({
      keywords: ["test"],
      industry: "科技",
      platforms: [],
    });

    // All queries return the same URL, should be deduped to 1
    const urls = result.items.map((i) => i.sourceUrl);
    const unique = new Set(urls);
    expect(unique.size).toBe(1);
  });

  it("captures errors without crashing", async () => {
    const searchFn = vi.fn().mockRejectedValue(new Error("Network error"));
    const collector = createWebSearchCollector(searchFn);

    const result = await collector.collect({
      keywords: ["fail"],
      industry: "科技",
      platforms: [],
    });

    expect(result.items).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Network error");
  });
});
