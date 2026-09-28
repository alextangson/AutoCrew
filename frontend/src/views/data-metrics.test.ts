import { describe, expect, it } from "vitest";
import { availability, fmtMetric, metricCell, metricThresholds, metricValue } from "./data-metrics";
import type { DataRow, Work } from "./data-lib";

let seq = 0;
const w = (platform: string, metrics: Record<string, number | null>): Work =>
  ({ key: `${platform}#${++seq}`, platform, title: "t", publishedAt: null, day: null, snapshots: [{ metricDate: "2026-09-26", recordedAt: null, source: "csv", metrics }] });
const row = (works: Work[], publishedOn: string[] = []): DataRow =>
  ({ id: `r${++seq}`, contentId: null, contentTitle: null, title: "t", day: "2026-09-01", works, publishedOn, link: "none", decisionId: null });

describe("点击率（播放 ÷ 曝光）", () => {
  it("有曝光才算；曝光为 0 或缺 → 没有", () => {
    expect(metricValue(w("xiaohongshu", { views: 50, impressions: 1000 }), "ctr")).toBeCloseTo(5);
    expect(metricValue(w("xiaohongshu", { views: 50, impressions: 0 }), "ctr")).toBeNull();
    expect(metricValue(w("douyin", { views: 50 }), "ctr")).toBeNull();
    // 平台直接给的封面点击率优先于 播放 ÷ 曝光
    expect(metricValue(w("douyin", { views: 50, coverClickRate: 24.3 }), "ctr")).toBeCloseTo(24.3);
    expect(metricValue(w("xiaohongshu", { views: 50, impressions: 1000, coverClickRate: 7 }), "ctr")).toBeCloseTo(7);
  });
});

describe("平台提供哪些指标：按实际数据判断", () => {
  it("任一作品报过就算提供", () => {
    const a = availability([row([w("douyin", { views: 1, completion5s: null })]), row([w("douyin", { views: 2, completion5s: 30 }), w("bilibili", { views: 3 })])]);
    expect(a.get("douyin")?.has("completion5s")).toBe(true);
    expect(a.get("bilibili")?.has("completionRate")).toBe(false);
  });
});

describe("按指标的中位数与加粗", () => {
  const rows = [10, 20, 30].map((c) => row([w("douyin", { views: 100, completionRate: c })]));
  it("率按率比；不足 3 条不加粗", () => {
    const t = metricThresholds(rows, "completionRate");
    expect(t.get("douyin")).toBe(20);
    const avail = availability(rows);
    expect(metricCell(rows[2], "douyin", "completionRate", t, avail)).toEqual({ kind: "data", value: 30, bold: true });
    expect(metricCell(rows[1], "douyin", "completionRate", t, avail)).toMatchObject({ bold: false });
    expect(metricThresholds(rows.slice(0, 2), "completionRate").size).toBe(0);
  });
  it("百分比一位小数，计数千分位", () => {
    expect(fmtMetric("completionRate", 2.1831)).toBe("2.2%");
    expect(fmtMetric("likes", 12345)).toBe("12,345");
  });
});

describe("单元格空态", () => {
  const rows = [row([w("douyin", { views: 5 }), w("xiaohongshu", { views: 5, impressions: 100 })], ["wechat_video"])];
  const avail = availability(rows);
  it("没发「—」/ 发了没回流「未回流」/ 目前没有这项数据「没有这项」", () => {
    expect(metricCell(rows[0], "bilibili", "views", new Map(), avail).kind).toBe("none");
    expect(metricCell(rows[0], "wechat_video", "views", new Map(), avail).kind).toBe("missing");
    expect(metricCell(rows[0], "douyin", "ctr", new Map(), avail).kind).toBe("unsupported");
    expect(metricCell(rows[0], "xiaohongshu", "ctr", new Map(), avail)).toMatchObject({ kind: "data", value: 5 });
  });
});
