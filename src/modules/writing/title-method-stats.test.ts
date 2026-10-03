import { describe, expect, it } from "vitest";
import type { Content } from "../../storage/local-store.js";
import type { PerformanceOutcome } from "../flywheel/outcome-schema.js";
import { aggregateTitleMethods, NO_DATA, trialStage, UNTAGGED } from "./title-method-stats.js";

let seq = 0;
function post(platform: string, method?: string, status = "published"): Content {
  const id = `c${++seq}`;
  const videoKit = method ? { platform, postTitle: "t", caption: "c", storyboard: [], coverText: "x", coverPrompt: "", generatedAt: "", titleMethod: method } : undefined;
  return { id, platform, status, title: "t", body: "b", videoKit } as unknown as Content;
}
function outcome(c: Content, metrics: PerformanceOutcome["metrics"]): PerformanceOutcome {
  return { contentId: c.id, platform: c.platform!, platformTitle: "t", publishedAt: null, metricDate: "2026-10-01", metrics, source: "auto", recordedAt: "", needsReview: false, reviewReasons: [] };
}
const row = (r: ReturnType<typeof aggregateTitleMethods>, m: string) => r.rows.find((x) => x.method === m);

describe("aggregateTitleMethods", () => {
  it("回流缺失：如实写「无数据」，平均只算有数据的，不把空值当 0", () => {
    const a = post("douyin", "twist"), b = post("douyin", "twist"), c = post("douyin", "a-or-b");
    const r = aggregateTitleMethods([a, b, c], [outcome(a, { coverClickRate: 6 })]);
    expect(row(r, "twist")).toMatchObject({ published: 2, withData: 1, avgClickRate: 6 });
    expect(row(r, "twist")!.clickRate).toContain("1/2");
    expect(row(r, "a-or-b")).toMatchObject({ published: 1, withData: 0, avgClickRate: null, clickRate: NO_DATA });
  });

  it("没有平台点击率时用 播放÷曝光；曝光为 0 或缺 = 无数据", () => {
    const a = post("xiaohongshu", "twist"), b = post("xiaohongshu", "a-or-b");
    const r = aggregateTitleMethods([a, b], [outcome(a, { views: 50, impressions: 1000 }), outcome(b, { views: 50, impressions: 0 })]);
    expect(row(r, "twist")!.avgClickRate).toBeCloseTo(5);
    expect(row(r, "a-or-b")!.clickRate).toBe(NO_DATA);
  });

  it("待复核的点击率不进均值：被复核理由点名的指标剔掉，剩不下 = 无数据", () => {
    const a = post("douyin", "twist"), b = post("douyin", "twist");
    const flagged = { ...outcome(a, { coverClickRate: 0.325 }), needsReview: true, reviewReasons: ["封面点击率 0.325 疑似把百分比写成小数"] };
    const r = aggregateTitleMethods([a, b], [flagged, outcome(b, { coverClickRate: 6 })]);
    expect(row(r, "twist")).toMatchObject({ published: 2, withData: 1, avgClickRate: 6 });
    const only = aggregateTitleMethods([a], [flagged]);
    expect(row(only, "twist")!.clickRate).toBe(NO_DATA);
  });

  it("旧稿没有方法 id → 「未标记」，自拟单列；两者都不计入试用期条数", () => {
    const r = aggregateTitleMethods([post("douyin"), post("douyin", "自拟"), post("douyin", "twist")], []);
    expect(row(r, UNTAGGED)).toMatchObject({ published: 1, name: UNTAGGED });
    expect(row(r, "自拟")).toMatchObject({ published: 1 });
    expect(r.publishedWithMethod).toBe(1);
  });

  it("发布包平台和稿件平台对不上 → 不认这个方法，归未标记；未发布的稿不计", () => {
    const stale = post("douyin", "twist");
    stale.videoKit!.platform = "bilibili";
    const r = aggregateTitleMethods([stale, post("douyin", "twist", "publish_ready")], []);
    expect(r.rows).toEqual([expect.objectContaining({ method: UNTAGGED, published: 1 })]);
  });

  it("回流数据按稿件平台取：同一 contentId 别的平台的数据不串", () => {
    const a = post("douyin", "twist");
    const r = aggregateTitleMethods([a], [{ ...outcome(a, { coverClickRate: 9 }), platform: "bilibili" }]);
    expect(row(r, "twist")!.clickRate).toBe(NO_DATA);
  });

  it("满 4 条中期提醒、满 8 条终版提醒；3 条没有提醒", () => {
    expect(trialStage(3)).toBe("none");
    expect(trialStage(4)).toBe("mid");
    expect(trialStage(8)).toBe("final");
    const four = aggregateTitleMethods(Array.from({ length: 4 }, () => post("douyin", "twist")), []);
    expect(four.reminder).toContain("中期");
    const eight = aggregateTitleMethods(Array.from({ length: 8 }, () => post("douyin", "twist")), []);
    expect(eight.reminder).toContain("终版");
    expect(aggregateTitleMethods([post("douyin", "twist")], []).reminder).toBeUndefined();
  });
});
