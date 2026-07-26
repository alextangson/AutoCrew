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
  updateWritingRule,
  addCompetitor,
  addVoiceSamples,
  detectMissingInfo,
  rulesForPlatform,
  type CreatorProfile,
} from "../profile/creator-profile.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-profile-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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

describe("rule scope routing (PRD-v4 §4.3)", () => {
  it("promotes a rule to voice_core when the same text recurs from another platform", async () => {
    await addWritingRule(
      { rule: "开头不用问候语", source: "auto_distilled", confidence: 0.8, scope: "platform:wechat_mp" },
      testDir,
    );
    const profile = await addWritingRule(
      { rule: "开头不用问候语", source: "auto_distilled", confidence: 0.8, scope: "platform:douyin" },
      testDir,
    );
    expect(profile.writingRules).toHaveLength(1);
    expect(profile.writingRules[0].scope).toBe("voice_core");
  });

  it("does not promote when the same platform corrects twice", async () => {
    await addWritingRule(
      { rule: "结尾加一句反问", source: "auto_distilled", confidence: 0.7, scope: "platform:wechat_mp" },
      testDir,
    );
    const profile = await addWritingRule(
      { rule: "结尾加一句反问", source: "auto_distilled", confidence: 0.7, scope: "platform:wechat_mp" },
      testDir,
    );
    expect(profile.writingRules).toHaveLength(1);
    expect(profile.writingRules[0].scope).toBe("platform:wechat_mp");
  });

  it("keeps voice_core scope when a platform-scoped duplicate arrives", async () => {
    await addWritingRule({ rule: "多用短句", source: "user_explicit", confidence: 1 }, testDir);
    const profile = await addWritingRule(
      { rule: "多用短句", source: "auto_distilled", confidence: 0.6, scope: "platform:douyin" },
      testDir,
    );
    expect(profile.writingRules).toHaveLength(1);
    // undefined scope = voice_core：已是内核，不降级
    expect(profile.writingRules[0].scope ?? "voice_core").toBe("voice_core");
  });

  it("rulesForPlatform injects voice_core + own platform, isolates other platforms", async () => {
    await addWritingRule({ rule: "内核规则", source: "user_explicit", confidence: 1, scope: "voice_core" }, testDir);
    await addWritingRule({ rule: "历史无scope规则", source: "user_explicit", confidence: 1 }, testDir);
    await addWritingRule(
      { rule: "公众号规则", source: "auto_distilled", confidence: 0.8, scope: "platform:wechat_mp" },
      testDir,
    );
    await addWritingRule(
      { rule: "抖音规则", source: "auto_distilled", confidence: 0.8, scope: "platform:douyin" },
      testDir,
    );
    const profile = (await loadProfile(testDir))!;

    const wechatRules = rulesForPlatform(profile, "wechat_mp").map((r) => r.rule);
    expect(wechatRules).toEqual(["内核规则", "历史无scope规则", "公众号规则"]);
  });

  it("rulesForPlatform excludes disabled rules", async () => {
    await addWritingRule({ rule: "被停用的规则", source: "user_explicit", confidence: 1 }, testDir);
    await updateWritingRule(0, { disabled: true }, testDir);
    const profile = (await loadProfile(testDir))!;
    expect(rulesForPlatform(profile, "wechat_mp")).toHaveLength(0);
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

describe("updateWritingRule", () => {
  it("edits rule text and toggles disabled", async () => {
    await addWritingRule({ rule: "原规则", source: "user_explicit", confidence: 1 }, testDir);
    let profile = await updateWritingRule(0, { rule: "新规则" }, testDir);
    expect(profile.writingRules[0].rule).toBe("新规则");

    profile = await updateWritingRule(0, { disabled: true }, testDir);
    expect(profile.writingRules[0].disabled).toBe(true);

    profile = await updateWritingRule(0, { disabled: false }, testDir);
    expect(profile.writingRules[0].disabled).toBe(false);
  });

  it("throws on bad index and empty rule text", async () => {
    await addWritingRule({ rule: "x", source: "user_explicit", confidence: 1 }, testDir);
    await expect(updateWritingRule(99, { disabled: true }, testDir)).rejects.toThrow("规则不存在");
    await expect(updateWritingRule(0, { rule: "  " }, testDir)).rejects.toThrow("不能为空");
  });
});

// ─── V5.1 受众画像:三层结构 + 归一化 + 渲染口径 ───────────────────────────────

describe("normalizeAudiencePersona / personaSummary (V5.1)", () => {
  it("历史扁平形状升格为 core 层;老 muse 嵌套形状原样通过", async () => {
    const { normalizeAudiencePersona } = await import("./creator-profile.js");
    const flat = normalizeAudiencePersona({ name: "效率控", painPoints: ["工具太多"], age: "30" });
    expect(flat!.core.name).toBe("效率控");
    expect(flat!.core.painPoints).toEqual(["工具太多"]);

    const muse = normalizeAudiencePersona({
      core: { name: "小林", age: "28", job: "连续创业者", coreAnxiety: "别人用AI在降维打击我" },
      adjacent: { name: "晓雯", job: "产品经理" },
      surprise: { name: "老张" },
      calibratedAt: "2026-07-08T00:00:00.000Z",
    });
    expect(muse!.core.coreAnxiety).toContain("降维打击");
    expect(muse!.adjacent!.name).toBe("晓雯");
    expect(muse!.calibratedAt).toBe("2026-07-08T00:00:00.000Z");
  });

  it("坏形状返回 null(读侧防御);loadProfile 读盘时自动归一", async () => {
    const { normalizeAudiencePersona, saveProfile, loadProfile } = await import("./creator-profile.js");
    expect(normalizeAudiencePersona(null)).toBeNull();
    expect(normalizeAudiencePersona("小林")).toBeNull();
    expect(normalizeAudiencePersona({ core: { age: "28" } })).toBeNull(); // 缺 name

    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "autocrew-persona-norm-"));
    try {
      const now = new Date().toISOString();
      await saveProfile({
        industry: "AI", platforms: [], writingRules: [],
        audiencePersona: { name: "扁平遗产", painPoints: ["p1"] } as never,
        styleBoundaries: { never: [], always: [] }, competitorAccounts: [],
        performanceHistory: [], styleCalibrated: false, createdAt: now, updatedAt: now,
      }, dir);
      const loaded = await loadProfile(dir);
      expect(loaded!.audiencePersona!.core.name).toBe("扁平遗产");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("personaSummary:core 一行;allTiers 三层拼接;空画像空串", async () => {
    const { personaSummary } = await import("./creator-profile.js");
    expect(personaSummary(null)).toBe("");
    const p = {
      core: { name: "小林", age: "28", job: "创业者", coreAnxiety: "不知道从哪切入" },
      adjacent: { name: "晓雯", painPoints: ["没技术背景"] },
    };
    expect(personaSummary(p)).toBe("小林(28·创业者):不知道从哪切入");
    const all = personaSummary(p, { allTiers: true });
    expect(all).toContain("核心受众=小林");
    expect(all).toContain("邻近受众=晓雯");
    expect(all).toContain("没技术背景");
  });
});

describe("addVoiceSamples (V5.7 声音样本)", () => {
  it("appends trimmed samples, dedupes by text, skips empties", async () => {
    await addVoiceSamples(["  第一段声音样本  ", "", "第二段"], testDir);
    await addVoiceSamples(["第一段声音样本", "第三段"], testDir);

    const profile = await loadProfile(testDir);
    expect(profile!.voiceSamples).toEqual(["第一段声音样本", "第二段", "第三段"]);
  });

  it("caps at 5 keeping the most recent", async () => {
    await addVoiceSamples(["s1", "s2", "s3", "s4", "s5"], testDir);
    await addVoiceSamples(["s6", "s7"], testDir);

    const profile = await loadProfile(testDir);
    expect(profile!.voiceSamples).toEqual(["s3", "s4", "s5", "s6", "s7"]);
  });

  it("survives updateProfile merges (field preserved when not in updates)", async () => {
    await addVoiceSamples(["保留我"], testDir);
    await updateProfile({ industry: "AI 教育" }, testDir);

    const profile = await loadProfile(testDir);
    expect(profile!.industry).toBe("AI 教育");
    expect(profile!.voiceSamples).toEqual(["保留我"]);
  });
});
