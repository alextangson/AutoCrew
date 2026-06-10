import { describe, it, expect } from "vitest";
import {
  getProfileLevel,
  inferFromRequest,
  getNudge,
} from "../profile/progressive-profiling.js";
import type { CreatorProfile } from "../profile/creator-profile.js";

function makeProfile(overrides: Partial<CreatorProfile> = {}): CreatorProfile {
  return {
    industry: "",
    platforms: [],
    audiencePersona: null,
    writingRules: [],
    styleBoundaries: { never: [], always: [] },
    competitorAccounts: [],
    performanceHistory: [],
    styleCalibrated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("getProfileLevel", () => {
  it("returns 0 for null profile", () => {
    expect(getProfileLevel(null)).toBe(0);
  });

  it("returns 0 for empty industry", () => {
    expect(getProfileLevel(makeProfile())).toBe(0);
  });

  it("returns 1 for profile with industry and platforms but not calibrated", () => {
    expect(getProfileLevel(makeProfile({ industry: "科技", platforms: ["xiaohongshu"] }))).toBe(1);
  });

  it("returns 2 for calibrated profile with no rules", () => {
    expect(getProfileLevel(makeProfile({
      industry: "科技",
      platforms: ["xiaohongshu"],
      styleCalibrated: true,
    }))).toBe(2);
  });

  it("returns 3 for fully mature profile", () => {
    expect(getProfileLevel(makeProfile({
      industry: "科技",
      platforms: ["xiaohongshu"],
      styleCalibrated: true,
      writingRules: [{ rule: "test", source: "auto_distilled", confidence: 0.8, createdAt: "" }],
    }))).toBe(3);
  });
});

describe("inferFromRequest", () => {
  it("infers platform from params", () => {
    const result = inferFromRequest({ platform: "douyin" });
    expect(result.platform).toBe("douyin");
  });

  it("infers 美妆护肤 industry from keyword", () => {
    const result = inferFromRequest({ keyword: "口红测评" });
    expect(result.industry).toBe("美妆护肤");
  });

  it("infers 科技数码 industry from title", () => {
    const result = inferFromRequest({ title: "AI 编程工具对比" });
    expect(result.industry).toBe("科技数码");
  });

  it("infers 职场成长 from body text", () => {
    const result = inferFromRequest({ body: "面试的时候如何谈薪资，跳槽注意事项" });
    expect(result.industry).toBe("职场成长");
  });

  it("returns empty for unrecognizable text", () => {
    const result = inferFromRequest({ keyword: "随便写写" });
    expect(result.industry).toBeUndefined();
  });
});

describe("getNudge", () => {
  it("returns industry nudge for level 0 with 1+ content", () => {
    const nudge = getNudge(makeProfile(), 1);
    expect(nudge).toContain("领域");
  });

  it("returns style calibration nudge for level 1 with 3+ content", () => {
    const nudge = getNudge(makeProfile({ industry: "科技", platforms: ["xhs"] }), 3);
    expect(nudge).toContain("风格校准");
  });

  it("returns null when no nudge needed", () => {
    const nudge = getNudge(makeProfile({
      industry: "科技",
      platforms: ["xhs"],
      styleCalibrated: true,
    }), 10);
    expect(nudge).toBeNull();
  });
});
