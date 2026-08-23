import { describe, it, expect } from "vitest";
import {
  attemptMessage,
  browserUnreachable,
  evidenceSummary,
  formatPullTime,
  pullBadge,
  pullHint,
  type PullPlatformStatus,
} from "./pull-lib";

function row(over: Partial<PullPlatformStatus> = {}): PullPlatformStatus {
  return {
    platform: "douyin",
    label: "抖音",
    consoleUrl: "https://creator.douyin.com",
    inFlight: false,
    enabled: true,
    lastSuccessAt: null,
    lastAttemptAt: null,
    nextEligibleAt: null,
    failureCount: 0,
    lastStatus: "never",
    ...over,
  };
}

describe("pullBadge — 状态徽标", () => {
  it("未启用优先于一切（关着的平台不该报错）", () => {
    expect(pullBadge(row({ enabled: false, lastStatus: "error" }))).toEqual({ text: "未启用", tone: "idle" });
  });

  it.each([
    ["never", "从未运行", "idle"],
    ["ok", "已连接", "ok"],
    ["needs_login", "需扫码", "warn"],
    ["risk_control", "风控暂停", "warn"],
    ["schema_changed", "接口变更", "bad"],
    ["browser_unreachable", "浏览器未连接", "bad"],
    ["timeout", "抓取失败", "bad"],
    ["error", "抓取失败", "bad"],
  ])("%s → %s", (status, text, tone) => {
    expect(pullBadge(row({ lastStatus: status }))).toEqual({ text, tone });
  });
});

describe("pullHint — 行内那句话", () => {
  it("需扫码时指向「去后台扫码」，不是「抓取失败」", () => {
    expect(pullHint(row({ lastStatus: "needs_login" }))).toContain("扫码");
  });

  it("失败时带脱敏错误码与连败次数", () => {
    const hint = pullHint(row({ lastStatus: "error", lastErrorCode: "http_503", failureCount: 2 }));
    expect(hint).toContain("http_503");
    expect(hint).toContain("2 次");
  });

  it("已连接时没什么要说的", () => {
    expect(pullHint(row({ lastStatus: "ok" }))).toBeNull();
  });

  it("刚开开关说清「最多等多久」，不让人以为没反应", () => {
    expect(pullHint(row({ lastStatus: "never" }))).toContain("30 分钟");
  });
});

describe("browserUnreachable — 三行合并成一条", () => {
  it("任一启用平台连不上浏览器就合并提示", () => {
    expect(browserUnreachable([row({ lastStatus: "browser_unreachable" }), row({ lastStatus: "ok" })])).toBe(true);
  });

  it("关着的平台留下的旧状态不算数", () => {
    expect(browserUnreachable([row({ enabled: false, lastStatus: "browser_unreachable" })])).toBe(false);
  });
});

describe("attemptMessage — 手动抓取的 toast", () => {
  it("成功报抓回与入账两个数（两者可能不等：行级 rejected）", () => {
    expect(attemptMessage("抖音", { platform: "douyin", status: "ok", rowCount: 12, imported: 11 })).toBe(
      "抖音：抓回 12 条，入账 11 条",
    );
  });

  it("状态没写住时如实带一句，不假装一切正常", () => {
    const msg = attemptMessage("抖音", { platform: "douyin", status: "ok", rowCount: 3, imported: 3, persistError: "EACCES" });
    expect(msg).toContain("下轮会重抓");
  });

  it("到分页上限只说「还有更多」，不谎报精确丢弃数", () => {
    const msg = attemptMessage("抖音", { platform: "douyin", status: "ok", rowCount: 200, imported: 200, hasMore: true });
    expect(msg).toContain("还有更多没抓完");
    expect(msg).not.toMatch(/丢弃 \d+/);
  });

  it("单飞拦下不报错，说清「正在抓」", () => {
    expect(attemptMessage("小红书", { platform: "xiaohongshu", status: "in_flight", rowCount: 0 })).toContain("正在抓");
  });

  it("接口变更明说零写入", () => {
    const msg = attemptMessage("视频号", {
      platform: "wechat_video",
      status: "schema_changed",
      rowCount: 0,
      errorCode: "missing:data.list",
    });
    expect(msg).toContain("missing:data.list");
    expect(msg).toContain("一行都没写入");
  });
});

describe("formatPullTime / evidenceSummary", () => {
  it("从未成功就说「从未成功」，不显示 1970", () => {
    expect(formatPullTime(null)).toBe("从未成功");
    expect(formatPullTime("不是时间")).toBe("—");
  });

  it("时间给到分钟", () => {
    expect(formatPullTime(new Date(2026, 7, 23, 9, 5).toISOString())).toBe("8-23 09:05");
  });

  it("证据摘要含样本数/对照值/差值/定龄口径", () => {
    const summary = evidenceSummary({
      metricFocus: "completionRate",
      ageDays: 7,
      platforms: ["douyin"],
      sampleSize: 6,
      baselineSampleSize: 20,
      testValue: 0.42,
      baselineValue: 0.3,
      relDiff: 0.4,
      reason: "相对差 40% 且方向一致",
      note: "观察性结论",
    });
    expect(summary).toBe("样本 6 篇 · 对照 20 篇 · 试验 0.42 · 基线 0.30 · 差 40% · D+7 定龄");
  });

  it("没有证据就没有摘要（open 的假设本来就没裁决过）", () => {
    expect(evidenceSummary(undefined)).toBeNull();
  });
});
