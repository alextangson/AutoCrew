import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getOnboardingStatus, completeOnboardingInit } from "./onboarding.js";
import { loadProfile, updateProfile } from "../modules/profile/creator-profile.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-onboarding-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("onboarding", () => {
  it("reports not onboarded when no profile exists", async () => {
    const res = await getOnboardingStatus({ _dataDir: testDir });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).onboarded).toBe(false);
  });

  it("init with defaults marks onboarded（跳过路径）", async () => {
    const init = await completeOnboardingInit({ _dataDir: testDir });
    expect(init.ok).toBe(true);
    const d = init.data as Record<string, unknown>;
    expect(d.industry).toBe("知识口播");
    expect(d.platforms).toEqual(["wechat_mp"]); // v4 P0 默认公众号（原 douyin）

    const status = await getOnboardingStatus({ _dataDir: testDir });
    expect((status.data as Record<string, unknown>).onboarded).toBe(true);
    expect((status.data as Record<string, unknown>).platforms).toEqual(["wechat_mp"]); // status 也返回席位
  });

  it("init accepts explicit industry and platforms", async () => {
    const init = await completeOnboardingInit({
      _dataDir: testDir,
      industry: "职场知识",
      platforms: ["douyin", "wechat_video"],
    });
    const d = init.data as Record<string, unknown>;
    expect(d.industry).toBe("职场知识");
    expect(d.platforms).toEqual(["douyin", "wechat_video"]);
  });
});

describe("onboarding persona (onboarding-connect §7.2-4, O18)", () => {
  it("saves the four answers + old work links; status reports complete", async () => {
    const r = await completeOnboardingInit({ _dataDir: testDir, industry: "AI 工具测评", platforms: ["douyin"], audience: "不写代码的职场人",
      voice: "像朋友聊天，不端着", referenceWorks: ["https://v.douyin.com/abc"] });
    expect(r).toMatchObject({ ok: true, data: { personaComplete: true } });
    const profile = await loadProfile(testDir);
    expect(profile).toMatchObject({ industry: "AI 工具测评", expressionPersona: "像朋友聊天，不端着", referenceWorks: ["https://v.douyin.com/abc"],
      audiencePersona: { core: { name: "不写代码的职场人" } } });
    expect((await getOnboardingStatus({ _dataDir: testDir })).data).toMatchObject({ personaComplete: true, personaSkipped: false });
  });

  it("rejects bad links and more than two, writes nothing new", async () => {
    expect(await completeOnboardingInit({ _dataDir: testDir, referenceWorks: ["not a url"] })).toMatchObject({ ok: false });
    expect(await completeOnboardingInit({ _dataDir: testDir, referenceWorks: ["https://a.x", "https://b.x", "https://c.x"] })).toMatchObject({ ok: false });
    expect((await loadProfile(testDir))?.referenceWorks).toBeUndefined();
  });

  it("O18: skip records the skip without fake defaults; completing later clears it", async () => {
    const r = await completeOnboardingInit({ _dataDir: testDir, skipped: true });
    expect(r).toMatchObject({ ok: true, data: { skipped: true, personaComplete: false } });
    expect((await getOnboardingStatus({ _dataDir: testDir })).data).toMatchObject({ personaSkipped: true, personaComplete: false, onboarded: false });
    await completeOnboardingInit({ _dataDir: testDir, industry: "x", platforms: ["douyin"], audience: "y", voice: "z" });
    expect((await getOnboardingStatus({ _dataDir: testDir })).data).toMatchObject({ personaSkipped: false, personaComplete: true });
  });

  it("does not overwrite an existing audience persona", async () => {
    await updateProfile({ audiencePersona: { core: { name: "校准过的小林" }, calibratedAt: "2026-01-01" } }, testDir);
    const r = await completeOnboardingInit({ _dataDir: testDir, audience: "别人", voice: "v" });
    expect((r.data as { note?: string }).note).toContain("没有覆盖");
    expect((await loadProfile(testDir))?.audiencePersona?.core.name).toBe("校准过的小林");
  });
});
