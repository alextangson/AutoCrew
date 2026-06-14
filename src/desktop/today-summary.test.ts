// src/desktop/today-summary.test.ts
import { describe, it, expect } from "vitest";
import { buildTodaySummary } from "./today-summary.js";
import type { Content } from "../storage/local-store.js";
import type { RadarItem } from "../modules/radar/topic-radar.js";

function content(over: Partial<Content>): Content {
  return {
    id: "content-1-x", title: "稿", body: "b", platform: "douyin", status: "draft_ready",
    tags: [], siblings: [], hashtags: [], publishedAt: null, publishUrl: null,
    performanceData: {}, assets: [], versions: [], createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z", ...over,
  } as Content;
}

const deps = (over: Partial<Parameters<typeof buildTodaySummary>[1]> = {}) => ({
  loadProfile: async () => ({ industry: "AI 技术" }) as { industry: string },
  cachedTopics: async () => [] as RadarItem[],
  listContents: async () => [] as Content[],
  buildBaseline: async () => ({ avgMetrics: {} as Record<string, number> }),
  now: () => new Date("2026-06-14T00:00:00.000Z").getTime(),
  ...over,
});

describe("buildTodaySummary", () => {
  it("returns industry, radar topics, and zeroed pipeline on an empty project", async () => {
    const r = await buildTodaySummary(undefined, deps());
    expect(r.industry).toBe("AI 技术");
    expect(r.radar.topics).toEqual([]);
    expect(r.pipeline).toMatchObject({ draft: 0, review: 0, ready: 0, published: 0, stale: null });
    expect(r.lastOutcome).toBeNull();
  });

  it("groups pipeline counts by status bucket", async () => {
    const r = await buildTodaySummary(undefined, deps({
      listContents: async () => [
        content({ id: "content-1-a", status: "draft_ready" }),
        content({ id: "content-1-b", status: "drafting" }),
        content({ id: "content-1-c", status: "reviewing" }),
        content({ id: "content-1-d", status: "publish_ready" }),
        content({ id: "content-1-e", status: "published", publishedAt: "2026-06-13T00:00:00.000Z" }),
        content({ id: "content-1-f", status: "archived" }),
      ],
    }));
    expect(r.pipeline).toMatchObject({ draft: 2, review: 1, ready: 1, published: 1 });
  });

  it("flags the oldest stale draft beyond STALE_DAYS", async () => {
    const r = await buildTodaySummary(undefined, deps({
      listContents: async () => [
        content({ id: "content-1-old", status: "draft_ready", title: "卡顿稿", updatedAt: "2026-06-10T00:00:00.000Z" }),
        content({ id: "content-1-fresh", status: "draft_ready", updatedAt: "2026-06-14T00:00:00.000Z" }),
      ],
    }));
    expect(r.pipeline.stale).toMatchObject({ id: "content-1-old", title: "卡顿稿" });
    expect(r.pipeline.stale!.days).toBeGreaterThanOrEqual(2);
  });

  it("no stale flag when all drafts are recent", async () => {
    const r = await buildTodaySummary(undefined, deps({
      listContents: async () => [content({ status: "draft_ready", updatedAt: "2026-06-14T00:00:00.000Z" })],
    }));
    expect(r.pipeline.stale).toBeNull();
  });

  it("reports last published outcome vs baseline completionRate", async () => {
    const r = await buildTodaySummary(undefined, deps({
      listContents: async () => [
        content({ id: "content-1-older", status: "published", title: "旧", publishedAt: "2026-06-10T00:00:00.000Z", performanceData: { completionRate: 30, views: 5000 } }),
        content({ id: "content-1-new", status: "published", title: "新", platform: "douyin", publishedAt: "2026-06-13T00:00:00.000Z", performanceData: { completionRate: 42, views: 12000 } }),
      ],
      buildBaseline: async () => ({ avgMetrics: { completionRate: 31, views: 8000 } }),
    }));
    expect(r.lastOutcome).toMatchObject({
      contentId: "content-1-new", title: "新", platform: "douyin",
      completionRate: 42, baselineCompletionRate: 31, views: 12000,
    });
  });

  it("degrades each source independently — a throwing source does not abort the rest", async () => {
    const r = await buildTodaySummary(undefined, deps({
      cachedTopics: async () => { throw new Error("radar boom"); },
      buildBaseline: async () => { throw new Error("baseline boom"); },
      listContents: async () => [content({ status: "reviewing" })],
    }));
    expect(r.radar.topics).toEqual([]);
    expect(r.pipeline.review).toBe(1);
    expect(r.lastOutcome).toBeNull();
  });
});
