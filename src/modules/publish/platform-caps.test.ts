/**
 * 平台能力表（全媒体 spec §8 Phase 1 #1）：英文平台的口径、按语言分开的默认发布平台、前端镜像同值。
 * 中文平台的现行口径钉在 platform-regression.test.ts。
 */
import { describe, it, expect } from "vitest";
import { capsOf, countTitleChars, kitPlatformsFor, METRICS_PLATFORMS, PLATFORM_CAPS, PLATFORM_IDS, videoPlatformsFor } from "./platform-caps.js";
import { videoTitleLimit } from "./video-kit.js";
import { captionBounds, validatePublishText } from "./publish-limits.js";
import { coverRatiosForPlatform } from "../cover/platform-ratios.js";
import { normalizePlatform, platformsNamedIn } from "./review-gate/platforms.js";
import { EGO_LITE_PUBLISH_URLS } from "./ego-lite.js";
import { BINDABLE_PLATFORMS } from "../flywheel/work-binding.js";
import { PULL_PLATFORMS } from "../flywheel/pull-state.js";
import { DEFAULT_COLUMNS } from "../../desktop/data-page.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";

describe("youtube / x 能力", () => {
  it("英文视频平台：16:9 封面、按字符计数、不回流、ego lite 发", () => {
    for (const p of ["youtube", "x"]) {
      const c = capsOf(p)!;
      expect(c).toMatchObject({ kind: "video", language: "en", titleCounter: "plain", metrics: "unsupported", publishChannel: "ego_lite" });
      expect(coverRatiosForPlatform(p)).toEqual(["16:9"]);
      expect(isVideoPlatform(p)).toBe(true);
      expect(EGO_LITE_PUBLISH_URLS[p as "youtube"]).toMatch(/^https:\/\//);
    }
  });
  it("标题上限：YouTube 100、X 280；英文按字符计，不做半字折算", () => {
    expect(videoTitleLimit("youtube")).toBe(100);
    expect(videoTitleLimit("x")).toBe(280);
    expect(countTitleChars("youtube", "Deep thinking at max")).toBe(20);
    expect(countTitleChars("douyin", "Deep thinking at max")).toBe(9);
    const r = validatePublishText("youtube", { title: "a".repeat(101), caption: "word ".repeat(10), tags: [] });
    expect(r[0]).toMatchObject({ field: "title", ok: false });
    expect(r[0].detail).toContain("按字符计");
    expect(captionBounds("x")).toEqual([20, 280]);
  });
  it("发布包字段：YouTube 要标签和章节，X 要帖子正文", () => {
    expect(PLATFORM_CAPS.youtube.kitFields).toEqual(["post_title", "caption", "tags", "chapters"]);
    expect(PLATFORM_CAPS.x.kitFields).toEqual(["post_text"]);
  });
  it("数据回流明确不含 youtube / x", () => {
    expect(METRICS_PLATFORMS).not.toContain("youtube");
    expect(BINDABLE_PLATFORMS).not.toContain("x");
    expect(PULL_PLATFORMS).not.toContain("youtube");
    expect(DEFAULT_COLUMNS).not.toContain("youtube");
  });
});

describe("按语言分开默认发布平台", () => {
  it("中文视频只列四个中文平台，英文版稿件只列 youtube / x", () => {
    expect(videoPlatformsFor("zh")).toEqual(["douyin", "wechat_video", "xiaohongshu", "bilibili"]);
    expect(kitPlatformsFor("douyin")).toEqual(["douyin", "wechat_video", "xiaohongshu", "bilibili"]);
    expect(kitPlatformsFor("youtube")).toEqual(["youtube", "x"]);
    expect(kitPlatformsFor(undefined)).toEqual(videoPlatformsFor("zh"));
  });
  it("把关认名：x 只精确认，不从一段话里的字母 x 认出来", () => {
    expect(normalizePlatform("X")).toBe("x");
    expect(normalizePlatform("Twitter")).toBe("x");
    expect(normalizePlatform("YouTube")).toBe("youtube");
    expect(platformsNamedIn("Max 和 xbox 都不是平台")).toEqual([]);
    // 只是提到英文平台名的规则不算点名，照旧适用于中文平台
    expect(platformsNamedIn("文案不能出现 YouTube 字样")).toEqual([]);
    expect(platformsNamedIn("别提推特和 Twitter")).toEqual([]);
  });
});

describe("前端镜像", () => {
  it("frontend/src/lib.ts 的 PLATFORM_CAPS 与后端逐项同值", async () => {
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(new URL("../../../frontend/src/lib.ts", import.meta.url), "utf8");
    const block = /PLATFORM_CAPS: Record<string, PlatformCapsMirror> = \{([\s\S]*?)\n\};/.exec(text)![1];
    const front = Object.fromEntries([...block.matchAll(/^\s+(\w+): (\{.*\}),$/gm)].map((m) => [m[1], JSON.parse(m[2])]));
    const back = Object.fromEntries(PLATFORM_IDS.map((p) => {
      const { label, kind, language, coverRatios, metrics } = PLATFORM_CAPS[p];
      return [p, { label, kind, language, coverRatios, metrics }];
    }));
    expect(front).toEqual(back);
    expect(Object.keys(front)).toEqual(PLATFORM_IDS);
  });
});
