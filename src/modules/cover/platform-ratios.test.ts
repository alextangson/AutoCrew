/**
 * platform-ratios.test.ts — 平台→封面比例单一事实源(后端)。
 * 创始人裁决 2026-07-12:短视频(抖音)封面同时要 3:4 与 4:3。
 */
import { describe, it, expect } from "vitest";
import { coverRatiosForPlatform } from "./platform-ratios.js";

describe("coverRatiosForPlatform", () => {
  it("公众号只 2.35:1;抖音 3:4+4:3(首项=默认主比例);B站横屏", () => {
    expect(coverRatiosForPlatform("wechat_mp")).toEqual(["2.35:1"]);
    expect(coverRatiosForPlatform("douyin")).toEqual(["3:4", "4:3"]);
    expect(coverRatiosForPlatform("bilibili")).toEqual(["16:9", "4:3"]);
    expect(coverRatiosForPlatform("xiaohongshu")).toEqual(["3:4"]);
  });
  it("未知平台回退全集,不误伤", () => {
    expect(coverRatiosForPlatform("toutiao")).toEqual(["3:4", "16:9", "4:3"]);
    expect(coverRatiosForPlatform(undefined)).toEqual(["3:4", "16:9", "4:3"]);
  });
});
