/**
 * review-locate.test.ts —— 打回定位（lifecycle spec §2.4 + §4 边界 #8）。
 *
 * 定位是纯函数，所以逐条锁死：落在覆盖轨上、落在句子里、落在间隙、越界、什么都没有。
 * 「不崩」不是靠观察得来的结论，是这里的一条用例。
 */
import { describe, it, expect } from "vitest";
import { locateReviewTarget, suggestedGate, type LocateSpan } from "./review-locate.js";

const overlays: LocateSpan[] = [
  { id: "ov-01", startMs: 30_000, endMs: 34_000 },
  { id: "ov-02", startMs: 50_000, endMs: 55_000 },
];
const segments: LocateSpan[] = [
  { id: "seg-0001", startMs: 0, endMs: 20_000 },
  // 20_000–25_000 是间隙（被剪掉的那段在输出域里根本不存在，这里模拟不连续的排布）
  { id: "seg-0002", startMs: 25_000, endMs: 40_000 },
  { id: "seg-0003", startMs: 45_000, endMs: 60_000 },
];

describe("locateReviewTarget", () => {
  it("落在覆盖轨里 → 定到那一槽（人那一秒看见的就是它）", () => {
    expect(locateReviewTarget(31_000, overlays, segments)).toEqual({ kind: "overlay", overlayId: "ov-01" });
    expect(locateReviewTarget(54_999, overlays, segments)).toEqual({ kind: "overlay", overlayId: "ov-02" });
  });

  it("覆盖轨区间左闭右开：起点算它，终点算下一段", () => {
    expect(locateReviewTarget(30_000, overlays, segments)).toEqual({ kind: "overlay", overlayId: "ov-01" });
    expect(locateReviewTarget(34_000, overlays, segments)).toEqual({ kind: "segment", segmentId: "seg-0002" });
  });

  it("没盖覆盖轨 → 定到覆盖那个时刻的分句", () => {
    expect(locateReviewTarget(5_000, overlays, segments)).toEqual({ kind: "segment", segmentId: "seg-0001" });
    expect(locateReviewTarget(46_000, [], segments)).toEqual({ kind: "segment", segmentId: "seg-0003" });
  });

  // 边界 #8：落间隙不崩，就近取分句
  it("落在间隙 → 就近取分句", () => {
    expect(locateReviewTarget(21_000, [], segments)).toEqual({ kind: "segment", segmentId: "seg-0001" });
    expect(locateReviewTarget(24_500, [], segments)).toEqual({ kind: "segment", segmentId: "seg-0002" });
  });

  it("越界（负数 / 超过片长）→ 取最近的一头，不返回 null", () => {
    expect(locateReviewTarget(-5_000, overlays, segments)).toEqual({ kind: "segment", segmentId: "seg-0001" });
    expect(locateReviewTarget(999_000, overlays, segments)).toEqual({ kind: "segment", segmentId: "seg-0003" });
  });

  it("没有任何分句（产物读不齐）→ null，而不是编一个出来", () => {
    expect(locateReviewTarget(1_000, [], [])).toBeNull();
    expect(locateReviewTarget(Number.NaN, overlays, segments)).toBeNull();
  });

  it("同样的输入永远同样的结果，与数组顺序无关", () => {
    const shuffled = [...segments].reverse();
    expect(locateReviewTarget(21_000, [], shuffled)).toEqual(locateReviewTarget(21_000, [], segments));
  });
});

describe("suggestedGate", () => {
  it("覆盖轨归门二，话归门一；没定位到也回门一（改选段是永远走得通的那条路）", () => {
    expect(suggestedGate({ kind: "overlay", overlayId: "ov-01" })).toBe("edit");
    expect(suggestedGate({ kind: "segment", segmentId: "seg-0001" })).toBe("cut");
    expect(suggestedGate(null)).toBe("cut");
  });
});
