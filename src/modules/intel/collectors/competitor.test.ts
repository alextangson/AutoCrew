import { describe, it, expect } from "vitest";
import { transformCompetitorResults } from "./competitor.js";
import type { ResearchItem } from "../../../adapters/browser/types.js";

describe("transformCompetitorResults", () => {
  it("produces correct IntelItems with competitor tags", () => {
    const results: ResearchItem[] = [
      {
        title: "Competitor Post 1",
        summary: "Their latest product launch",
        url: "https://xiaohongshu.com/note/123",
        platform: "xiaohongshu",
        source: "browser_cdp",
      },
      {
        title: "Competitor Post 2",
        url: "https://xiaohongshu.com/note/456",
        platform: "xiaohongshu",
        source: "browser_cdp",
      },
    ];

    const items = transformCompetitorResults(results, "竞品A", "美妆", "xiaohongshu");
    expect(items).toHaveLength(2);
    expect(items[0].source).toBe("competitor");
    expect(items[0].domain).toBe("美妆");
    expect(items[0].tags).toContain("competitor:竞品A");
    expect(items[0].tags).toContain("xiaohongshu");
    expect(items[0].title).toBe("Competitor Post 1");
    expect(items[0].summary).toBe("Their latest product launch");
    expect(items[0].sourceUrl).toBe("https://xiaohongshu.com/note/123");
    expect(items[0].relevance).toBe(60);
  });

  it("filters out items without titles", () => {
    const results: ResearchItem[] = [
      {
        title: "",
        platform: "xiaohongshu",
        source: "browser_cdp",
      },
      {
        title: "Valid Title",
        platform: "xiaohongshu",
        source: "browser_cdp",
      },
    ];

    const items = transformCompetitorResults(results, "竞品B", "科技", "xiaohongshu");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Valid Title");
  });

  it("handles empty results array", () => {
    const items = transformCompetitorResults([], "竞品C", "教育", "bilibili");
    expect(items).toEqual([]);
  });

  it("uses empty string for missing summary", () => {
    const results: ResearchItem[] = [
      {
        title: "No Summary",
        platform: "douyin",
        source: "browser_cdp",
      },
    ];

    const items = transformCompetitorResults(results, "竞品D", "美食", "douyin");
    expect(items[0].summary).toBe("");
  });
});
