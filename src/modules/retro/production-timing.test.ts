/**
 * production-timing.test.ts — 生产用时的确定性计算。
 * 纯函数、零 IO：口径(三段/中位数/缺戳跳过)出错必须在这里炸。
 */
import { describe, it, expect } from "vitest";
import { computeProductionTiming, formatDuration, timingFactsBlock } from "./production-timing.js";
import type { Content } from "../../storage/local-store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** 只填计时关心的字段，其余凑够 Content 形状 */
function content(over: Partial<Content>): Content {
  return {
    id: "content-1", title: "t", body: "b", status: "published", tags: [],
    siblings: [], hashtags: [], publishedAt: null, publishUrl: null, performanceData: {},
    assets: [], versions: [], createdAt: iso(0), updatedAt: iso(0),
    ...over,
  };
}

/** 开写 0h → 稿成 draftH 小时 → 发布 pubH 小时 */
function timed(id: string, draftH: number, pubH: number): Content {
  return content({
    id, createdAt: iso(0), draftReadyAt: iso(draftH * HOUR), publishedAt: iso(pubH * HOUR),
  });
}

describe("formatDuration", () => {
  it("按量级说人话：分钟 / 小时+分 / 天+小时", () => {
    expect(formatDuration(30_000)).toBe("不到 1 分钟");
    expect(formatDuration(45 * MINUTE)).toBe("45 分钟");
    expect(formatDuration(3 * HOUR)).toBe("3 小时");
    expect(formatDuration(3 * HOUR + 20 * MINUTE)).toBe("3 小时 20 分钟");
    expect(formatDuration(DAY + 3 * HOUR)).toBe("1 天 3 小时");
    expect(formatDuration(2 * DAY)).toBe("2 天");
  });
});

describe("computeProductionTiming", () => {
  it("空窗口：三段全 null，不产出任何假读数", () => {
    const t = computeProductionTiming([]);
    expect(t.published).toBe(0);
    expect(t.missingStamps).toBe(0);
    for (const seg of [t.drafting, t.toPublish, t.endToEnd]) {
      expect(seg).toEqual({ count: 0, medianMs: null, medianText: null });
    }
  });

  it("单条：中位数就是它自己，三段都算得出", () => {
    const t = computeProductionTiming([timed("content-a", 2, 26)]);
    expect(t.published).toBe(1);
    expect(t.missingStamps).toBe(0);
    expect(t.drafting).toMatchObject({ count: 1, medianMs: 2 * HOUR, medianText: "2 小时" });
    expect(t.toPublish).toMatchObject({ count: 1, medianMs: 24 * HOUR, medianText: "1 天" });
    expect(t.endToEnd).toMatchObject({ count: 1, medianMs: 26 * HOUR, medianText: "1 天 2 小时" });
  });

  it("奇数条取中间值，与顺序无关", () => {
    const t = computeProductionTiming([timed("content-a", 5, 10), timed("content-b", 1, 2), timed("content-c", 3, 6)]);
    expect(t.drafting).toMatchObject({ count: 3, medianMs: 3 * HOUR });
    expect(t.endToEnd).toMatchObject({ count: 3, medianMs: 6 * HOUR });
  });

  it("偶数条取中间两条的均值", () => {
    const t = computeProductionTiming([timed("content-a", 1, 2), timed("content-b", 2, 4), timed("content-c", 4, 8), timed("content-d", 9, 18)]);
    expect(t.drafting).toMatchObject({ count: 4, medianMs: 3 * HOUR });
  });

  it("缺稿成戳的旧稿：分段跳过并计数，全程照算——不倒推、不编造", () => {
    const legacy = content({ id: "content-old", createdAt: iso(0), publishedAt: iso(48 * HOUR) });
    const t = computeProductionTiming([timed("content-new", 2, 4), legacy]);

    expect(t.published).toBe(2);
    expect(t.missingStamps).toBe(1);
    // 缺戳的那篇不进两个分段
    expect(t.drafting).toMatchObject({ count: 1, medianMs: 2 * HOUR });
    expect(t.toPublish).toMatchObject({ count: 1, medianMs: 2 * HOUR });
    // 全程两头都有戳，两篇都算
    expect(t.endToEnd).toMatchObject({ count: 2, medianMs: 26 * HOUR });
  });

  it("时序倒挂/戳不可解析：整条作废计入缺戳，不产出负用时", () => {
    const inverted = content({ id: "content-x", createdAt: iso(10 * HOUR), draftReadyAt: iso(2 * HOUR), publishedAt: iso(20 * HOUR) });
    const garbage = content({ id: "content-y", createdAt: "not-a-date", draftReadyAt: iso(HOUR), publishedAt: iso(2 * HOUR) });
    const t = computeProductionTiming([inverted, garbage]);

    expect(t.missingStamps).toBe(2);
    expect(t.drafting.count).toBe(0);
    expect(t.endToEnd.count).toBe(1); // inverted 的 createdAt→publishedAt 仍是正向
    expect(t.endToEnd.medianMs).toBe(10 * HOUR);
  });
});

describe("第四段:稿成→成片(视频线)", () => {
  /** 开写 0h → 稿成 draftH → 成片 videoH → 发布 pubH */
  function videoed(id: string, draftH: number, videoH: number, pubH: number): Content {
    return content({
      id,
      createdAt: iso(0),
      draftReadyAt: iso(draftH * HOUR),
      videoReadyAt: iso(videoH * HOUR),
      publishedAt: iso(pubH * HOUR),
    });
  }

  it("只统计有成片戳的稿件，中位数取自 draftReadyAt→videoReadyAt", () => {
    const t = computeProductionTiming([videoed("content-a", 2, 6, 8), videoed("content-b", 1, 9, 12), timed("content-c", 1, 2)]);
    expect(t.toVideo).toMatchObject({ count: 2, medianMs: 6 * HOUR }); // 4h 与 8h 的均值
    expect(t.missingVideoStamps).toBe(0); // 没给视频活动名单 = 不追究缺戳
  });

  it("没剪过片的稿件既不进分子也不进缺戳——既有三段一个数都不许变", () => {
    const plain = [timed("content-a", 2, 4), timed("content-b", 4, 8)];
    const before = computeProductionTiming(plain);
    const after = computeProductionTiming(plain, []);

    expect(after.drafting).toEqual(before.drafting);
    expect(after.toPublish).toEqual(before.toPublish);
    expect(after.endToEnd).toEqual(before.endToEnd);
    expect(after.missingStamps).toBe(0);
    expect(after.toVideo).toEqual({ count: 0, medianMs: null, medianText: null });
    expect(after.missingVideoStamps).toBe(0);
  });

  it("剪过片但没走到审片通过：只计 missingVideoStamps，不污染 missingStamps", () => {
    const building = timed("content-building", 2, 6); // 有视频活动、无 videoReadyAt
    const t = computeProductionTiming([videoed("content-done", 1, 3, 5), building], ["content-building", "content-done"]);

    expect(t.toVideo).toMatchObject({ count: 1, medianMs: 2 * HOUR });
    expect(t.missingVideoStamps).toBe(1);
    expect(t.missingStamps).toBe(0); // 三段的戳齐全,与视频线无关
  });

  it("缺稿成戳导致成片段算不出：同样只进视频缺戳计数", () => {
    const noDraft = content({ id: "content-x", createdAt: iso(0), videoReadyAt: iso(5 * HOUR), publishedAt: iso(9 * HOUR) });
    const t = computeProductionTiming([noDraft], ["content-x"]);
    expect(t.toVideo.count).toBe(0);
    expect(t.missingVideoStamps).toBe(1);
    expect(t.missingStamps).toBe(1); // 这一篇本来就缺 draftReadyAt,既有口径照旧计
  });

  it("时序倒挂(成片戳早于稿成)作废，不产出负用时", () => {
    const inverted = content({
      id: "content-y", createdAt: iso(0), draftReadyAt: iso(10 * HOUR),
      videoReadyAt: iso(2 * HOUR), publishedAt: iso(20 * HOUR),
    });
    const t = computeProductionTiming([inverted], ["content-y"]);
    expect(t.toVideo.count).toBe(0);
    expect(t.missingVideoStamps).toBe(1);
  });
});

describe("timingFactsBlock", () => {
  it("有数据：三段都出人话读数，并显式点名未计入的篇数", () => {
    const legacy = content({ id: "content-old", createdAt: iso(0), publishedAt: iso(DAY) });
    const block = timingFactsBlock(computeProductionTiming([timed("content-new", 2, 4), legacy]));

    expect(block).toContain("开写→稿成:中位 2 小时(1 篇)");
    expect(block).toContain("稿成→发布:中位 2 小时(1 篇)");
    expect(block).toContain("全程(开写→发布)");
    expect(block).toContain("1 篇缺时间戳未计入");
  });

  it("空窗口：明说无数据 + 禁止编造，不留空白", () => {
    const block = timingFactsBlock(computeProductionTiming([]));
    expect(block).toContain("无用时可算");
    expect(block).toContain("不要编造");
    expect(block).not.toContain("中位");
  });

  it("没剪过片：不多出「稿成→成片」这一行(不给没做视频的人添噪音)", () => {
    const block = timingFactsBlock(computeProductionTiming([timed("content-a", 2, 4)]));
    expect(block).not.toContain("稿成→成片");
    expect(block).not.toContain("成片戳");
  });

  it("剪过片：成片用时与缺戳篇数各出一行", () => {
    const done = content({
      id: "content-v", createdAt: iso(0), draftReadyAt: iso(HOUR),
      videoReadyAt: iso(4 * HOUR), publishedAt: iso(6 * HOUR),
    });
    const building = timed("content-w", 1, 3);
    const block = timingFactsBlock(computeProductionTiming([done, building], ["content-v", "content-w"]));

    expect(block).toContain("稿成→成片:中位 3 小时(1 篇)");
    expect(block).toContain("1 篇剪过片但没有成片戳");
  });

  it("全部缺戳：分段写「无数据」而不是 0 或 null", () => {
    const legacy = content({ id: "content-old", createdAt: iso(0), publishedAt: iso(DAY) });
    const block = timingFactsBlock(computeProductionTiming([legacy]));
    expect(block).toContain("开写→稿成:无数据");
    expect(block).toContain("全程(开写→发布):中位 1 天(1 篇)");
  });
});
