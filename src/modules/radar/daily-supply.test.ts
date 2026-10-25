import { describe, it, expect } from "vitest";
import { countToday, refillDue, supplyView, localDate, MAX_REFILLS, type SupplyState } from "./daily-supply.js";

const now = new Date("2026-10-25T15:00:00").getTime();
const state = (extra: Partial<SupplyState> = {}): SupplyState => ({ date: localDate(now), refills: 0, lastRefillAt: null, engineUnavailable: false, lastError: null, ...extra });

describe("每日供给", () => {
  it("只数今天入库的雷达选题（含回收站里的）", () => {
    const today = new Date("2026-10-25T09:00:00").toISOString();
    const yesterday = new Date("2026-10-24T23:00:00").toISOString();
    expect(countToday([
      { source: "radar:HN", createdAt: today }, { source: "radar:X", createdAt: today },
      { source: "manual", createdAt: today }, { source: "radar:HN", createdAt: yesterday },
    ], now)).toBe(2);
  });

  it("补抓：不够数、有次数、隔够久才补", () => {
    expect(refillDue(state(), 4, now)).toBe(true);
    expect(refillDue(state(), 10, now)).toBe(false);
    expect(refillDue(state({ refills: MAX_REFILLS }), 0, now)).toBe(false);
    expect(refillDue(state({ refills: 1, lastRefillAt: new Date(now - 3600_000).toISOString() }), 0, now)).toBe(false);
    expect(refillDue(state({ refills: 1, lastRefillAt: new Date(now - 4 * 3600_000).toISOString() }), 0, now)).toBe(true);
  });

  it("3 轮用完仍不够 / 没配引擎 → short，带原因；够数不提示", () => {
    expect(supplyView(state({ refills: 3 }), 6)).toMatchObject({ short: true, today: 6, target: 10 });
    expect(supplyView(state({ refills: 3, lastError: "源抓取失败：HN" }), 6).reason).toContain("HN");
    expect(supplyView(state({ engineUnavailable: true }), 0).reason).toContain("打分没接上");
    expect(supplyView(state({ refills: 1 }), 6).short).toBe(false);
    expect(supplyView(state({ refills: 3, engineUnavailable: true }), 10).short).toBe(false);
  });
});
