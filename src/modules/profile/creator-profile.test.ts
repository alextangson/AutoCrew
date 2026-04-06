import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  initProfile,
  loadProfile,
  saveProfile,
  updateProfile,
  addWritingRule,
  addCompetitor,
  detectMissingInfo,
  type CreatorProfile,
} from "../profile/creator-profile.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-profile-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("initProfile", () => {
  it("creates a new empty profile", async () => {
    const profile = await initProfile(testDir);
    expect(profile.industry).toBe("");
    expect(profile.platforms).toEqual([]);
    expect(profile.styleCalibrated).toBe(false);
    expect(profile.writingRules).toEqual([]);
  });

  it("is idempotent — does not overwrite existing profile", async () => {
    await initProfile(testDir);
    // Manually update
    const existing = await loadProfile(testDir);
    existing!.industry = "科技";
    await saveProfile(existing!, testDir);

    // Init again — should not overwrite
    const profile = await initProfile(testDir);
    expect(profile.industry).toBe("科技");
  });
});

describe("loadProfile", () => {
  it("returns null when profile does not exist", async () => {
    const profile = await loadProfile(testDir);
    expect(profile).toBeNull();
  });

  it("loads a saved profile", async () => {
    await initProfile(testDir);
    const profile = await loadProfile(testDir);
    expect(profile).not.toBeNull();
    expect(profile!.createdAt).toBeTruthy();
  });
});

describe("updateProfile", () => {
  it("merges partial updates", async () => {
    await initProfile(testDir);
    const updated = await updateProfile({ industry: "美妆", platforms: ["xhs", "douyin"] }, testDir);
    expect(updated.industry).toBe("美妆");
    expect(updated.platforms).toEqual(["xhs", "douyin"]);
  });

  it("preserves fields not in the update", async () => {
    await initProfile(testDir);
    await updateProfile({ industry: "科技" }, testDir);
    const updated = await updateProfile({ platforms: ["xhs"] }, testDir);
    expect(updated.industry).toBe("科技");
    expect(updated.platforms).toEqual(["xhs"]);
  });

  it("updates updatedAt timestamp", async () => {
    const profile = await initProfile(testDir);
    const before = profile.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateProfile({ industry: "教育" }, testDir);
    expect(updated.updatedAt).not.toBe(before);
  });
});

describe("addWritingRule", () => {
  it("adds a new rule", async () => {
    await initProfile(testDir);
    const profile = await addWritingRule(
      { rule: "禁用顺序词", source: "auto_distilled", confidence: 0.9 },
      testDir,
    );
    expect(profile.writingRules).toHaveLength(1);
    expect(profile.writingRules[0].rule).toBe("禁用顺序词");
  });

  it("deduplicates rules by text", async () => {
    await initProfile(testDir);
    await addWritingRule({ rule: "禁用顺序词", source: "auto_distilled", confidence: 0.9 }, testDir);
    const profile = await addWritingRule(
      { rule: "禁用顺序词", source: "user_explicit", confidence: 1.0 },
      testDir,
    );
    expect(profile.writingRules).toHaveLength(1);
  });

  it("adds multiple distinct rules", async () => {
    await initProfile(testDir);
    await addWritingRule({ rule: "规则A", source: "auto_distilled", confidence: 0.8 }, testDir);
    const profile = await addWritingRule(
      { rule: "规则B", source: "user_explicit", confidence: 1.0 },
      testDir,
    );
    expect(profile.writingRules).toHaveLength(2);
  });
});

describe("addCompetitor", () => {
  it("adds a competitor account", async () => {
    await initProfile(testDir);
    const profile = await addCompetitor(
      { platform: "xhs", profileUrl: "https://xhs.com/user/123", name: "测试账号" },
      testDir,
    );
    expect(profile.competitorAccounts).toHaveLength(1);
    expect(profile.competitorAccounts[0].name).toBe("测试账号");
  });

  it("deduplicates by profileUrl", async () => {
    await initProfile(testDir);
    await addCompetitor(
      { platform: "xhs", profileUrl: "https://xhs.com/user/123", name: "账号A" },
      testDir,
    );
    const profile = await addCompetitor(
      { platform: "xhs", profileUrl: "https://xhs.com/user/123", name: "账号B" },
      testDir,
    );
    expect(profile.competitorAccounts).toHaveLength(1);
    expect(profile.competitorAccounts[0].name).toBe("账号A");
  });
});

describe("videoCrawler and omniConfig", () => {
  it("saves and loads videoCrawler and omniConfig", async () => {
    const profile = await initProfile(testDir);
    const full: CreatorProfile = {
      ...profile,
      videoCrawler: { type: "mediacrawl", command: "python3 /opt/mediacrawl/main.py" },
      omniConfig: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "sk-test-key-123",
      },
    };
    await saveProfile(full, testDir);
    const loaded = await loadProfile(testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.videoCrawler).toEqual({ type: "mediacrawl", command: "python3 /opt/mediacrawl/main.py" });
    expect(loaded!.omniConfig).toEqual({
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2-omni",
      apiKey: "sk-test-key-123",
    });
  });

  it("loads profile without video config (backward compatible)", async () => {
    // Write a minimal JSON file without the new fields
    const filePath = path.join(testDir, "creator-profile.json");
    const legacy = {
      industry: "科技",
      platforms: ["xhs"],
      audiencePersona: null,
      creatorPersona: null,
      writingRules: [],
      styleBoundaries: { never: [], always: [] },
      competitorAccounts: [],
      performanceHistory: [],
      expressionPersona: "",
      secondaryPersonas: [],
      styleCalibrated: false,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    await fs.writeFile(filePath, JSON.stringify(legacy, null, 2), "utf-8");

    const loaded = await loadProfile(testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.industry).toBe("科技");
    expect(loaded!.videoCrawler).toBeUndefined();
    expect(loaded!.omniConfig).toBeUndefined();
  });
});

describe("detectMissingInfo", () => {
  it("reports all missing fields on empty profile", async () => {
    const profile = await initProfile(testDir);
    const missing = detectMissingInfo(profile);
    expect(missing).toContain("industry");
    expect(missing).toContain("platforms");
    expect(missing).toContain("audience");
    expect(missing).toContain("style");
  });

  it("reports nothing when profile is complete", async () => {
    const profile = await initProfile(testDir);
    const complete: CreatorProfile = {
      ...profile,
      industry: "科技",
      platforms: ["xhs"],
      audiencePersona: { name: "职场人", painPoints: [] },
      styleCalibrated: true,
    };
    const missing = detectMissingInfo(complete);
    expect(missing).toHaveLength(0);
  });

  it("reports only missing fields", async () => {
    const profile = await initProfile(testDir);
    await updateProfile({ industry: "美妆", platforms: ["xhs"] }, testDir);
    const updated = await loadProfile(testDir);
    const missing = detectMissingInfo(updated!);
    expect(missing).not.toContain("industry");
    expect(missing).not.toContain("platforms");
    expect(missing).toContain("audience");
    expect(missing).toContain("style");
  });
});
