import { describe, expect, it } from "vitest";
import {
  boldThresholds, cellOf, dayLabel, fmtRate, groupByMonth, median, pickMonth, platformCards, pullLine, rowsInPeriod, coverFileProblem, coverSrc,
  type DataRow, type Work,
} from "./data-lib";

function work(platform: string, views: number | null, rate: number | null = null): Work {
  return { key: `${platform}-${views}-${Math.random()}`, platform, title: "t", publishedAt: null, day: null, snapshots: [{ metricDate: "2026-09-26", recordedAt: null, source: "csv", metrics: { views, completionRate: rate } }] };
}
function row(day: string | null, works: Work[], extra: Partial<DataRow> = {}): DataRow {
  return { id: `${day}-${Math.random()}`, contentId: null, contentTitle: null, title: "t", day, works, publishedOn: [], link: "none", decisionId: null, ...extra };
}

const OCT_1 = Date.parse("2026-10-01T02:00:00+08:00");
const SEP_28 = Date.parse("2026-09-28T12:00:00+08:00");

describe("月份（§37）", () => {
  const rows = [row("2026-09-24", []), row("2026-08-22", [])];
  it("本月有数据 → 本月", () => {
    expect(pickMonth(rows, SEP_28)).toEqual({ month: "2026-09", fallback: false });
  });
  it("本月还没有数据 → 最近有数据的月份，并标记回退", () => {
    expect(pickMonth(rows, OCT_1)).toEqual({ month: "2026-09", fallback: true });
  });
  it("一条都没有 → 没有月份", () => {
    expect(pickMonth([], OCT_1)).toEqual({ month: null, fallback: true });
  });
  it("按北京时间切月：UTC 还在 9 月 30 日，北京已经 10 月", () => {
    expect(pickMonth([row("2026-10-01", [])], Date.parse("2026-09-30T17:00:00Z")).fallback).toBe(false);
  });
  it("分组新→旧，组内已关联在前、未关联在后", () => {
    const g = groupByMonth([row("2026-08-01", []), row("2026-09-02", []), row("2026-09-05", [], { contentId: "c" })]);
    expect(g.map((x) => x.month)).toEqual(["2026-09", "2026-08"]);
    expect(g[0].linked).toHaveLength(1);
    expect(g[0].unlinked).toHaveLength(1);
    expect(rowsInPeriod(rows, "month", "2026-08")).toHaveLength(1);
    expect(rowsInPeriod(rows, "all", null)).toHaveLength(2);
  });
});

describe("中位数与加粗（§38 / §40）", () => {
  it("中位数奇偶", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("少于 3 条 → 不给中位数；没数据的平台不出卡", () => {
    const rows = [row("2026-09-01", [work("douyin", 10), work("bilibili", 1)]), row("2026-09-02", [work("douyin", 20)]), row("2026-09-03", [work("douyin", 30)])];
    const cards = platformCards(rows, ["douyin", "wechat_video", "bilibili"]);
    expect(cards).toEqual([
      { platform: "douyin", count: 3, median: 20 },
      { platform: "bilibili", count: 1, median: null },
    ]);
  });
  it("加粗用全部历史中位数，不是当月；历史不足 3 条不加粗", () => {
    const all = [row("2026-08-01", [work("douyin", 100)]), row("2026-08-02", [work("douyin", 200)]), row("2026-09-01", [work("douyin", 150), work("bilibili", 9)])];
    const t = boldThresholds(all);
    expect(t.get("douyin")).toBe(150);
    expect(t.has("bilibili")).toBe(false);
    expect(cellOf(all[1], "douyin", t)).toMatchObject({ kind: "data", bold: true });
    expect(cellOf(all[2], "douyin", t)).toMatchObject({ kind: "data", bold: false });
  });
});

describe("单元格三态（§39）与格式（§41）", () => {
  it("有数据 / 发了没回流 / 没发", () => {
    const r = row("2026-09-01", [work("douyin", 5, 2.1831)], { contentId: "c", publishedOn: ["douyin", "xiaohongshu"] });
    expect(cellOf(r, "douyin", new Map())).toMatchObject({ kind: "data", views: 5, rate: 2.1831 });
    expect(cellOf(r, "xiaohongshu", new Map())).toEqual({ kind: "missing" });
    expect(cellOf(r, "bilibili", new Map())).toEqual({ kind: "none" });
  });
  it("百分比一位小数", () => {
    expect(fmtRate(2.1831)).toBe("2.2%");
    expect(fmtRate(5)).toBe("5.0%");
  });
  it("日期带星期", () => {
    expect(dayLabel("2026-09-24")).toBe("09-24 周四");
  });
});

describe("回流状态行（§42 / §43）", () => {
  const base = { consoleUrl: "", inFlight: false, lastSuccessAt: null, lastAttemptAt: null, nextEligibleAt: null, failureCount: 0 };
  it("没开 / 开了正常 / 登录过期变红 / 读不出来变红", () => {
    expect(pullLine([{ ...base, platform: "douyin", label: "抖音", enabled: false, lastStatus: "never" }], null)).toEqual({ state: "自动回流没开", problem: null });
    expect(pullLine([{ ...base, platform: "douyin", label: "抖音", enabled: true, lastStatus: "ok" }], null).problem).toBeNull();
    expect(pullLine([{ ...base, platform: "douyin", label: "抖音", enabled: true, lastStatus: "needs_login" }], null).problem).toMatch(/在 ego lite 里登录抖音后台/);
    expect(pullLine(null, "boom").problem).toMatch(/boom/);
  });
  it("封面没下载成写进状态行（§I.57）", () => {
    const r = pullLine([{ ...base, platform: "douyin", label: "抖音", enabled: true, lastStatus: "ok", lastCoverError: "cover_download_failed:2/12:http_403" }], null);
    expect(r.state).toBe("自动回流已开（抖音）（抖音封面 2/12 张没下载成）");
  });
});

describe("当前写入权丢失盖过旧的浏览器未连接", () => {
  const base = { consoleUrl: "", inFlight: false, lastSuccessAt: null, lastAttemptAt: null, nextEligibleAt: null, failureCount: 0 };
  it("pullLine 报写入权丢失与恢复办法，不报浏览器", () => {
    const r = pullLine([{ ...base, platform: "douyin", label: "抖音", enabled: true, lastStatus: "browser_unreachable", writeRefusal: { code: "library_writer_lost", at: "2026-10-04T01:00:00.000Z" } }], null);
    expect(r.problem).toMatch(/资料库写入权已丢失/);
    expect(r.problem).toMatch(/重启/);
    expect(r.problem).not.toMatch(/浏览器/);
  });
});

describe("封面（§I.56）", () => {
  it("只收 png / jpg / webp，≤10MB", () => {
    expect(coverFileProblem({ type: "image/png", size: 1 })).toBeNull();
    expect(coverFileProblem({ type: "image/gif", size: 1 })).toMatch(/png/);
    expect(coverFileProblem({ type: "image/webp", size: 10 * 1024 * 1024 + 1 })).toMatch(/10MB/);
  });
  it("地址：AutoCrew 封面走稿件产物，其它走数据页封面端点", () => {
    expect(coverSrc({ kind: "manual", file: "manual-a.png", key: "w:x" })).toBe("/api/data/cover-file?name=manual-a.png");
    expect(coverSrc({ kind: "autocrew", contentId: "c1", path: "05-cover/封面-3x4.png", sha256: "ab" })).toContain("/api/project-artifact?content_id=c1");
  });
});
