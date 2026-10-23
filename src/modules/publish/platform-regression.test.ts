/**
 * 四个中文视频平台 + 公众号的现行口径钉死（全媒体 spec §8 Phase 1）：平台能力表重构前写下，重构后必须原样通过。
 * 唯一允许的变化：公众号正文上限 3000 → 4000（spec §7 #8）。
 */
import { describe, it, expect } from "vitest";
import { VIDEO_PLATFORMS, isVideoPlatform } from "../../storage/stage-guard.js";
import { videoTitleLimit, publishTitleChars } from "./video-kit.js";
import { PLATFORM_MIN_BODY, PLATFORM_MAX_BODY, captionBounds, validatePublishText } from "./publish-limits.js";
import { ALLOWED_COVER_SLOTS, COVER_RATIOS_BY_PLATFORM, coverRatiosForPlatform } from "../cover/platform-ratios.js";
import { normalizePlatform, platformsNamedIn, platformLabel, PLATFORM_LABEL } from "./review-gate/platforms.js";
import { EGO_LITE_PUBLISH_URLS } from "./ego-lite.js";
import { kitLimitsText } from "../../tools/pre-publish-kit.js";
import { BINDABLE_PLATFORMS } from "../flywheel/work-binding.js";
import { PULL_PLATFORMS } from "../flywheel/pull-state.js";
import { DEFAULT_COLUMNS } from "../../desktop/data-page.js";

const ZH_VIDEO = ["douyin", "wechat_video", "xiaohongshu", "bilibili"];

describe("中文平台现行口径（回归钉）", () => {
  it("视频平台四个都认，公众号不是视频平台", () => {
    for (const p of ZH_VIDEO) expect(VIDEO_PLATFORMS.has(p)).toBe(true);
    expect(isVideoPlatform("wechat_mp")).toBe(false);
    expect(isVideoPlatform(undefined)).toBe(false);
  });
  it("发布标题上限与加权计数", () => {
    expect(ZH_VIDEO.map(videoTitleLimit)).toEqual([30, 22, 20, 40]);
    expect(videoTitleLimit("wechat_mp")).toBe(30);
    expect(videoTitleLimit("toutiao")).toBe(30);
    expect(publishTitleChars("深度思考 AI agent 2026")).toBe(10);
    expect(publishTitleChars("abc")).toBe(2);
  });
  it("文案上下限（公众号上限改为 4000，其余不变）", () => {
    expect(PLATFORM_MIN_BODY).toMatchObject({ xiaohongshu: 200, xhs: 200, douyin: 100, wechat_mp: 800, wechat_video: 100, bilibili: 200 });
    expect(PLATFORM_MAX_BODY).toMatchObject({ xiaohongshu: 1000, xhs: 1000, wechat_video: 800, bilibili: 2000, wechat_mp: 4000 });
    expect(PLATFORM_MAX_BODY.douyin).toBeUndefined();
    expect(captionBounds("douyin")).toEqual([20, undefined]);
    expect(captionBounds("wechat_video")).toEqual([20, 800]);
  });
  it("validatePublishText 输出原样", () => {
    const r = validatePublishText("xiaohongshu", { title: "一二三四五六七八九十一二三四五六七八九十一", caption: "字".repeat(30), tags: ["AI"] });
    expect(r).toEqual([
      { field: "title", ok: false, detail: "标题 21 字（加权计数：中文 1、英文数字半字、空格不计），xiaohongshu 上限 20" },
      { field: "tags", ok: true, detail: "1 个标签（并进文案末尾，计入文案字数）" },
      { field: "caption", ok: true, detail: "文案 35 字（字符串长度，含并入的标签），下限 20，xiaohongshu 上限 1000" },
    ]);
  });
  it("封面上传槽与回退", () => {
    expect(Object.fromEntries(ZH_VIDEO.concat("wechat_mp").map((p) => [p, COVER_RATIOS_BY_PLATFORM[p]]))).toEqual({
      wechat_mp: ["2.35:1"], xiaohongshu: ["3:4"], wechat_video: ["3:4", "4:3"], douyin: ["3:4", "4:3"], bilibili: ["4:3"],
    });
    expect(Object.fromEntries(ZH_VIDEO.concat("wechat_mp").map((p) => [p, ALLOWED_COVER_SLOTS[p]]))).toEqual({
      wechat_mp: ["2.35:1"], xiaohongshu: ["3:4", "4:3", "1:1"], wechat_video: ["3:4", "4:3"], douyin: ["3:4", "4:3"], bilibili: ["4:3", "16:9"],
    });
    expect(coverRatiosForPlatform("toutiao")).toEqual(["3:4", "16:9", "4:3"]);
  });
  it("把关平台名与别名", () => {
    expect(normalizePlatform("小红书")).toBe("xiaohongshu");
    expect(normalizePlatform("TikTok")).toBe("douyin");
    expect(normalizePlatform("b站")).toBe("bilibili");
    expect(normalizePlatform("channels")).toBe("wechat_video");
    expect(normalizePlatform("wechat_mp")).toBeNull();
    expect(platformsNamedIn("先发B站，再发视频号和红书")).toEqual(["bilibili", "wechat_video", "xiaohongshu"]);
    expect(platformsNamedIn("标题里写 max 和 xbox 不算平台")).toEqual([]);
    expect(PLATFORM_LABEL).toMatchObject({ douyin: "抖音", xiaohongshu: "小红书", wechat_video: "视频号", bilibili: "B站" });
    expect(platformLabel("toutiao")).toBe("toutiao");
  });
  it("ego-lite 发布入口", () => {
    expect(EGO_LITE_PUBLISH_URLS).toMatchObject({
      wechat_video: "https://channels.weixin.qq.com/platform/post/create",
      xiaohongshu: "https://creator.xiaohongshu.com/publish/publish",
      douyin: "https://creator.douyin.com/creator-micro/content/upload",
      bilibili: "https://member.bilibili.com/platform/upload/video/frame",
    });
  });
  it("发布包工具说明的上限文字", () => {
    expect(kitLimitsText()).toBe("post_title 上限：douyin 30 / wechat_video 22 / xiaohongshu 20 / bilibili 40（中文 1 字、英文数字半字、空格不计）；caption ≥20 字，上限：douyin 不设 / wechat_video 800 / xiaohongshu 1000 / bilibili 2000；cover_text ≤12 字");
  });
  it("数据回流平台", () => {
    expect([...BINDABLE_PLATFORMS]).toEqual(["douyin", "wechat_video", "xiaohongshu", "bilibili", "wechat_mp"]);
    expect([...PULL_PLATFORMS]).toEqual(["douyin", "wechat_video", "xiaohongshu"]);
    expect(DEFAULT_COLUMNS).toEqual(ZH_VIDEO);
  });
});
