import { describe, it, expect } from "vitest";
import { formatForClipboard, type ClipboardPlatform } from "../publish/clipboard-publisher.js";

describe("formatForClipboard", () => {
  const title = "5个护肤技巧让你皮肤变好";
  const body = "第一个技巧是每天涂防晒。\n\n第二个技巧是保湿。\n\n第三个技巧是清洁。";
  const hashtags = ["护肤", "美妆", "防晒"];

  it("formats for xiaohongshu with hashtags at end", () => {
    const result = formatForClipboard("xiaohongshu", title, body, hashtags);
    expect(result.platform).toBe("xiaohongshu");
    expect(result.copyText).toContain(title);
    expect(result.copyText).toContain("#护肤");
    expect(result.publishUrl).toContain("xiaohongshu.com");
    expect(result.tips.length).toBeGreaterThan(0);
  });

  it("formats for douyin with short text", () => {
    const result = formatForClipboard("douyin", title, body, hashtags);
    expect(result.platform).toBe("douyin");
    expect(result.publishUrl).toContain("douyin.com");
    expect(result.formattedBody).toContain("#护肤");
  });

  it("formats for wechat_mp without hashtags", () => {
    const result = formatForClipboard("wechat_mp", title, body, hashtags);
    expect(result.platform).toBe("wechat_mp");
    expect(result.publishUrl).toContain("weixin.qq.com");
    // WeChat MP doesn't use hashtags in body
    expect(result.formattedBody).not.toContain("#护肤");
  });

  it("formats for bilibili", () => {
    const result = formatForClipboard("bilibili", title, body, hashtags);
    expect(result.platform).toBe("bilibili");
    expect(result.publishUrl).toContain("bilibili.com");
  });

  it("handles empty hashtags", () => {
    const result = formatForClipboard("xiaohongshu", title, body, []);
    expect(result.copyText).not.toContain("#");
  });

  it("handles hashtags with # prefix", () => {
    const result = formatForClipboard("xiaohongshu", title, body, ["#已有前缀", "无前缀"]);
    expect(result.copyText).toContain("#已有前缀");
    expect(result.copyText).toContain("#无前缀");
    // Should not double-prefix
    expect(result.copyText).not.toContain("##");
  });

  const platforms: ClipboardPlatform[] = ["xiaohongshu", "douyin", "wechat_mp", "wechat_video", "bilibili"];
  for (const platform of platforms) {
    it(`returns valid publishUrl for ${platform}`, () => {
      const result = formatForClipboard(platform, title, body, hashtags);
      expect(result.publishUrl).toMatch(/^https:\/\//);
    });
  }
});
