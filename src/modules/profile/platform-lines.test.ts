/**
 * 勾选平台 → 生产线开关（全媒体 spec Phase 1 增补，创始人 2026-10-23）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enKitPlatforms, enabledPlatforms, legacyTwitterPrompt, lineEnabled, lineRefusal, normalizeProfilePlatforms } from "./platform-lines.js";
import { initProfile, loadProfile } from "./creator-profile.js";
import { getPackForPlatform } from "../packs/index.js";
import { TWITTER_POST_PACK } from "../packs/twitter-post.js";

/** 创始人 2026-10-23 的真实档案 */
const FOUNDER = ["xiaohongshu", "douyin", "wechat_mp", "wechat_video", "bilibili", "toutiao", "twitter", "reddit"];

describe("normalizeProfilePlatforms", () => {
  // spec §9.3（创始人 2026-10-24）：twitter 不再改名成 x
  it("去重保序、twitter 原样；字符串化的数组也认；坏形状给空", () => {
    expect(normalizeProfilePlatforms(["douyin", "twitter", "x", "", "x"])).toEqual(["douyin", "twitter", "x"]);
    expect(normalizeProfilePlatforms('["wechat_mp","twitter"]')).toEqual(["wechat_mp", "twitter"]);
    expect(normalizeProfilePlatforms(42)).toEqual([]);
  });
});

describe("lineEnabled / enKitPlatforms", () => {
  it("创始人现有档案（只有旧 twitter）：公众号线开、英文线不开，出一次明确选择的提示", () => {
    const p = { platforms: FOUNDER };
    expect(lineEnabled(p, "wechat_article")).toBe(true);
    expect(lineEnabled(p, "en_edition")).toBe(false);
    expect(enKitPlatforms(p)).toEqual([]);
    expect(legacyTwitterPrompt(p)).toMatch(/X 或 YouTube/);
    expect(legacyTwitterPrompt({ platforms: [...FOUNDER, "x"] })).toBeNull();
    expect(legacyTwitterPrompt({ platforms: [...FOUNDER, "youtube"] })).toBeNull();
    expect(legacyTwitterPrompt({ platforms: ["douyin"] })).toBeNull();
  });
  it("公众号线只看 wechat_mp，英文线看 youtube 或 x；英文包只含勾了的", () => {
    expect(lineEnabled({ platforms: ["douyin"] }, "wechat_article")).toBe(false);
    expect(lineRefusal({ platforms: ["douyin"] }, "wechat_article")).toMatch(/公众号/);
    expect(lineEnabled({ platforms: ["douyin"] }, "en_edition")).toBe(false);
    expect(lineRefusal(null, "en_edition")).toMatch(/YouTube 或 X/);
    expect(enKitPlatforms({ platforms: ["youtube"] })).toEqual(["youtube"]);
    expect(enKitPlatforms({ platforms: ["x", "youtube"] })).toEqual(["youtube", "x"]);
  });
});

describe("档案读侧归一", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-lines-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("旧档案存的 twitter 读出来还是 twitter（只管图文推）", async () => {
    await initProfile(dir);
    const file = path.join(dir, "creator-profile.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...raw, platforms: FOUNDER }));
    expect((await loadProfile(dir))!.platforms).toEqual(["xiaohongshu", "douyin", "wechat_mp", "wechat_video", "bilibili", "toutiao", "twitter", "reddit"]);
  });
});

it("图文推特包照旧按稿件平台 twitter 认", () => {
  expect(getPackForPlatform("twitter")).toBe(TWITTER_POST_PACK);
});
