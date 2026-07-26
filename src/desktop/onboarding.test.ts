import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getOnboardingStatus, completeOnboardingInit } from "./onboarding.js";

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
