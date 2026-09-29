/**
 * platform-ratios.test.ts — 平台→封面上传槽单一事实源(后端)。
 * 创始人 2026-09-29(发布前把关 spec §3):小红书 3:4;抖音、视频号 3:4+4:3;B站 4:3 + 16:9 裁切核对。
 */
import { describe, it, expect } from "vitest";
import { COVER_CROP_CHECKS, COVER_RATIOS_BY_PLATFORM, coverRatiosForPlatform, effectiveCoverRatios, ratioValue } from "./platform-ratios.js";

describe("coverRatiosForPlatform", () => {
  it("09-29 上传槽表:公众号 2.35:1;小红书 3:4;抖音/视频号 3:4+4:3;B站只 4:3", () => {
    expect(coverRatiosForPlatform("wechat_mp")).toEqual(["2.35:1"]);
    expect(coverRatiosForPlatform("douyin")).toEqual(["3:4", "4:3"]);
    expect(coverRatiosForPlatform("wechat_video")).toEqual(["3:4", "4:3"]);
    expect(coverRatiosForPlatform("bilibili")).toEqual(["4:3"]);
    expect(coverRatiosForPlatform("xiaohongshu")).toEqual(["3:4"]);
  });
  it("B站另有一项 16:9 裁切核对,不是上传槽", () => {
    expect(COVER_CROP_CHECKS.bilibili?.[0]).toMatch(/16:9 裁切核对/);
    expect(COVER_CROP_CHECKS.douyin).toBeUndefined();
  });
  it("未知平台回退全集,不误伤", () => {
    expect(coverRatiosForPlatform("toutiao")).toEqual(["3:4", "16:9", "4:3"]);
    expect(coverRatiosForPlatform(undefined)).toEqual(["3:4", "16:9", "4:3"]);
  });
  it("前端镜像同源同值:frontend/src/lib.ts 的 COVER_RATIOS_BY_PLATFORM 与后端逐项相等", async () => {
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(new URL("../../../frontend/src/lib.ts", import.meta.url), "utf8");
    const block = /COVER_RATIOS_BY_PLATFORM: Record<string, string\[\]> = \{([\s\S]*?)\};/.exec(text)![1];
    const front = Object.fromEntries([...block.matchAll(/(\w+): (\[[^\]]*\])/g)].map((m) => [m[1], JSON.parse(m[2])]));
    expect(front).toEqual(COVER_RATIOS_BY_PLATFORM);
  });
  it("账号资料覆盖优先;空覆盖不算", () => {
    expect(effectiveCoverRatios("xiaohongshu", { xiaohongshu: ["3:4", "4:3"] })).toEqual(["3:4", "4:3"]);
    expect(effectiveCoverRatios("xiaohongshu", { xiaohongshu: [] })).toEqual(["3:4"]);
    expect(ratioValue("3:4")).toBe(0.75);
    expect(ratioValue("abc")).toBeNull();
  });
});
