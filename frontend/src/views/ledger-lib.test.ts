import { describe, expect, it } from "vitest";
import {
  EMPTY_LEDGER_TEXT, actualText, countsText, deviationText, distributionText, hitRateText, isBadStatus, recordLine, statusText, summaryProblems,
  type LedgerSummary,
} from "./ledger-lib";

const summary = (over: Partial<LedgerSummary> = {}): LedgerSummary => ({
  rubric_version: "v1", samples: 0, confidence: { label: "🔴 极低", meaning: "" }, hit_rate: [], alerts: [],
  counts: { pending: 0, due: 0, awaiting_data: 0, awaiting_interpretation: 0 }, reconcile: null, integrity_problems: [], ...over,
});

describe("预测账本文字", () => {
  it("空状态提示下一条视频出发布包时做第一次盲预测", () => {
    expect(EMPTY_LEDGER_TEXT).toContain("下一条视频出发布包时会做第一次盲预测");
  });
  it("六种状态各有说法；待复盘带到期日，没发布的说没发布", () => {
    expect(statusText({ status: "pending", due_date: "2026-10-07T12:00:00Z" })).toMatch(/待复盘 · 10\/7/);
    expect(statusText({ status: "pending", due_date: null })).toMatch(/还没发布/);
    expect(statusText({ status: "awaiting_data", due_date: null })).toBe("等数据");
    expect(statusText({ status: "reconciled", due_date: null })).toMatch(/已对账/);
    expect(statusText({ status: "interpreted", due_date: null })).toBe("已解读");
    expect(statusText({ status: "reconstructed", due_date: null })).toMatch(/事后补记.*不进校准/);
    expect(statusText({ status: "integrity_warning", due_date: null })).toMatch(/完整性警告/);
    expect(isBadStatus("integrity_warning")).toBe(true);
    expect(isBadStatus("interpreted")).toBe(false);
  });
  it("偏差带符号；中枢为 0（JSON 里是 null）不写成 NaN", () => {
    expect(deviationText(25.5)).toBe("+25.5%");
    expect(deviationText(-40)).toBe("-40%");
    expect(deviationText(null)).toMatch(/无法算/);
  });
  it("已对账一行：实际、落档、偏差、命中、谁写的", () => {
    const t = actualText({ views: 2000, landed_bucket: "命中", deviation_pct: 10, hit: true, metric_date: "2026-10-04", source: "回流", by: "auto" });
    expect(t).toMatch(/落在「命中」/);
    expect(t).toMatch(/命中 · 自动对账/);
    expect(t).toMatch(/2026-10-04/);
  });
  it("五档概率与命中率", () => {
    expect(distributionText({ 底部: 30, 命中: 70 })).toBe("底部 30% · 命中 70%");
    expect(hitRateText([], (p) => p)).toMatch(/还没有/);
    expect(hitRateText([{ platform: "douyin", n: 4, hits: 1 }], () => "抖音")).toBe("命中率：抖音 1/4");
  });
  it("对账出错与日志完整性问题进汇总条，没问题时为空", () => {
    expect(summaryProblems(summary())).toEqual([]);
    const p = summaryProblems(summary({ reconcile: { at: "", ok: false, code: "library_writer_lost", error: "丢锁" }, integrity_problems: ["第 2 行被改过"] }));
    expect(p).toHaveLength(2);
    expect(p[0]).toMatch(/丢锁/);
  });
  it("计数文字与复盘记录行", () => {
    expect(countsText({ pending: 2, due: 1, awaiting_data: 3, awaiting_interpretation: 4 })).toMatch(/已到期 1.*等数据 3.*待解读 4/);
    expect(recordLine({ type: "retro", numeric_by: "auto", at: "2026-10-04T01:00:00Z" })).toMatch(/数字对账（自动）/);
    expect(recordLine({ type: "reading", day: 7, actual: {}, at: "2026-10-08T01:00:00Z" })).toMatch(/D\+7 读数 —/);
    expect(recordLine({ type: "interpretation", hypothesis_conclusion: "钩子撑住了" })).toMatch(/解读：钩子撑住了/);
  });

  it("复盘与解读记录展开时带上验证/推翻的因素和新观察", () => {
    const vf = [{ factor: "钩子", verdict: "验证", note: "前 3 秒留住了" }, { factor: "议题", verdict: "推翻", note: "" }];
    for (const type of ["retro", "interpretation"]) {
      const t = recordLine({ type, hypothesis_conclusion: "结论", verified_factors: vf, observations: ["具体场景开头留人"] });
      expect(t).toMatch(/钩子：验证（前 3 秒留住了）/);
      expect(t).toMatch(/议题：推翻/);
      expect(t).toMatch(/观察：具体场景开头留人/);
    }
  });
});
