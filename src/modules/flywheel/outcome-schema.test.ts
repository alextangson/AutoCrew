import { describe, it, expect } from "vitest";
import {
  validateOutcome,
  outcomeKey,
  normalizeTitle,
  KOUBO_REWARD,
  type OutcomeMetrics,
} from "./outcome-schema.js";

describe("normalizeTitle", () => {
  it("strips punctuation, whitespace and lowercases", () => {
    expect(normalizeTitle("5个护肤技巧，让你皮肤变好！")).toBe("5个护肤技巧让你皮肤变好");
    expect(normalizeTitle("  AI Agent 入门 (2026) ")).toBe("aiagent入门2026");
  });
  it("strips emoji", () => {
    expect(normalizeTitle("🔥爆款标题🔥")).toBe("爆款标题");
  });
});

describe("validateOutcome", () => {
  const base = {
    metrics: { views: 1000, completionRate: 35.2 } as OutcomeMetrics,
    publishedAt: "2026-06-01T10:00:00.000Z",
    metricDate: "2026-06-08",
  };

  it("accepts valid outcome", () => {
    const v = validateOutcome(base);
    expect(v.ok).toBe(true);
    expect(v.needsReview).toBe(false);
  });

  it("rejects completionRate outside 0-100", () => {
    const v = validateOutcome({ ...base, metrics: { completionRate: 135 } });
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toContain("完播率");
  });

  it("rejects negative metrics", () => {
    const v = validateOutcome({ ...base, metrics: { views: -5 } });
    expect(v.ok).toBe(false);
  });

  it("rejects metricDate earlier than publishedAt", () => {
    const v = validateOutcome({ ...base, metricDate: "2026-05-20" });
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toContain("早于发布");
  });

  it("rejects empty metrics", () => {
    const v = validateOutcome({ ...base, metrics: {} });
    expect(v.ok).toBe(false);
  });

  it("flags zero views with engagement as needsReview, not rejection", () => {
    const v = validateOutcome({ ...base, metrics: { views: 0, likes: 30 } });
    expect(v.ok).toBe(true);
    expect(v.needsReview).toBe(true);
    expect(v.reasons.join()).toContain("播放为 0");
  });

  it("accepts null publishedAt (historical import without publish time)", () => {
    const v = validateOutcome({ ...base, publishedAt: null });
    expect(v.ok).toBe(true);
  });

  it("rejects metricDate not in YYYY-MM-DD format", () => {
    const v = validateOutcome({ ...base, metricDate: "2026/06/08" });
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toContain("格式");
  });

  it("rejects NaN metric values", () => {
    const v = validateOutcome({ ...base, metrics: { views: NaN } });
    expect(v.ok).toBe(false);
  });

  it("rejects Infinity metric values", () => {
    const v = validateOutcome({ ...base, metrics: { completionRate: Infinity } });
    expect(v.ok).toBe(false);
  });

  it("accepts boundary completionRate 0 and 100", () => {
    expect(validateOutcome({ ...base, metrics: { completionRate: 0 } }).ok).toBe(true);
    expect(validateOutcome({ ...base, metrics: { completionRate: 100 } }).ok).toBe(true);
  });

  it("accepts metricDate equal to publish date (same-day)", () => {
    const v = validateOutcome({ ...base, metricDate: "2026-06-01" });
    expect(v.ok).toBe(true);
  });
  it("accepts negative follows (粉丝掉粉合法)", () => {
    const v = validateOutcome({ ...base, metrics: { follows: -12, views: 100 } });
    expect(v.ok).toBe(true);
  });
  it("still rejects other negative metrics like views", () => {
    const v = validateOutcome({ ...base, metrics: { views: -5 } });
    expect(v.ok).toBe(false);
  });

  it("flags raw-ratio completionRate (0-1) as needsReview, not rejection", () => {
    const v = validateOutcome({ ...base, metrics: { views: 100, completionRate: 0.32 } });
    expect(v.ok).toBe(true);
    expect(v.needsReview).toBe(true);
    expect(v.reasons.join()).toContain("小数比例");
  });
});

describe("outcomeKey", () => {
  it("uses contentId when present", () => {
    const key = outcomeKey({
      contentId: "c123",
      platform: "douyin",
      platformTitle: "标题A",
      publishedAt: "2026-06-01T10:00:00.000Z",
      metricDate: "2026-06-08",
    });
    expect(key).toBe("douyin:c123:2026-06-08");
  });

  it("falls back to normalized title + publish date for historical items", () => {
    const key = outcomeKey({
      contentId: null,
      platform: "douyin",
      platformTitle: "5个护肤技巧！",
      publishedAt: "2026-06-01T10:00:00.000Z",
      metricDate: "2026-06-08",
    });
    expect(key).toBe("douyin:5个护肤技巧@2026-06-01:2026-06-08");
  });

  it("same content same metricDate yields same key (idempotency basis)", () => {
    const a = { contentId: "c1", platform: "douyin", platformTitle: "x", publishedAt: null, metricDate: "2026-06-08" };
    expect(outcomeKey(a)).toBe(outcomeKey({ ...a }));
  });

  it("pure-emoji title does not produce an empty item segment", () => {
    const key = outcomeKey({
      contentId: null,
      platform: "douyin",
      platformTitle: "🔥🔥",
      publishedAt: "2026-06-01T10:00:00.000Z",
      metricDate: "2026-06-08",
    });
    expect(key).not.toContain("douyin:@");
    expect(key).toContain("🔥🔥");
  });
});

describe("KOUBO_REWARD", () => {
  it("primary signal is completion rate (口播赛道)", () => {
    expect(KOUBO_REWARD.primary).toBe("completionRate");
  });
});
