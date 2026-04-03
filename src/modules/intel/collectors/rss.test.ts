import { describe, it, expect } from "vitest";
import { parseRssItems } from "./rss.js";
import type { RssItem } from "./rss.js";

describe("parseRssItems", () => {
  it("transforms RSS items into IntelItems", () => {
    const items: RssItem[] = [
      {
        title: "AI Breakthrough",
        link: "https://example.com/article",
        contentSnippet: "Major AI advancement announced today",
        isoDate: "2024-01-15T10:00:00Z",
        categories: ["tech", "ai"],
      },
    ];

    const result = parseRssItems(items, "科技", ["rss-source"]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("AI Breakthrough");
    expect(result[0].domain).toBe("科技");
    expect(result[0].source).toBe("rss");
    expect(result[0].sourceUrl).toBe("https://example.com/article");
    expect(result[0].summary).toBe("Major AI advancement announced today");
    expect(result[0].tags).toEqual(["rss-source", "tech", "ai"]);
    expect(result[0].collectedAt).toBe("2024-01-15T10:00:00Z");
  });

  it("handles missing fields gracefully", () => {
    const items: RssItem[] = [
      { title: "No Link Article" },
      { title: undefined }, // should be filtered out
      { title: "Minimal", content: "Full content here that is quite long and should be sliced" },
    ];

    const result = parseRssItems(items, "默认");
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("No Link Article");
    expect(result[0].sourceUrl).toBeUndefined();
    expect(result[0].summary).toBe("");
    expect(result[0].tags).toEqual([]);
    expect(result[1].title).toBe("Minimal");
    expect(result[1].summary).toContain("Full content");
  });

  it("uses isoDate when available, falls back to now", () => {
    const withDate: RssItem[] = [{ title: "Dated", isoDate: "2024-06-01T00:00:00Z" }];
    const withoutDate: RssItem[] = [{ title: "Undated" }];

    const dated = parseRssItems(withDate, "test");
    const undated = parseRssItems(withoutDate, "test");

    expect(dated[0].collectedAt).toBe("2024-06-01T00:00:00Z");
    // Should be a valid ISO date (now-ish)
    expect(new Date(undated[0].collectedAt).getTime()).toBeGreaterThan(0);
  });
});
