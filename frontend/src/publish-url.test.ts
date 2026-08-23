/**
 * 平台链接的前端校验（发布闭环 spec §3.2）。
 *
 * 两条纪律分开测:**协议白名单是硬拒**(输入拒收 + 渲染前再过一次,存量脏数据也不许
 * 变成可点链接),**平台域名不符只是提醒**(一稿多投、短链、自建域都可能合法,拦了是添乱)。
 */
import { describe, it, expect } from "vitest";
import { isHttpUrl, needsPublishUrlBackfill, publishUrlPlatformWarning } from "./lib";

describe("isHttpUrl", () => {
  it("只认 http/https", () => {
    expect(isHttpUrl("https://www.douyin.com/video/123")).toBe(true);
    expect(isHttpUrl("http://example.com/a")).toBe(true);
    expect(isHttpUrl("  https://example.com/a  ")).toBe(true);
  });

  it("拒收非 http(s) 与不成形的输入", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("www.douyin.com/video/123")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("needsPublishUrlBackfill", () => {
  it("已发布且没链接 → 出补记入口", () => {
    expect(needsPublishUrlBackfill({ status: "published" })).toBe(true);
    expect(needsPublishUrlBackfill({ status: "published", publishUrl: null })).toBe(true);
    expect(needsPublishUrlBackfill({ status: "published", publishUrl: "" })).toBe(true);
  });

  it("已发布且链接可用 → 不出（活儿已经干完了）", () => {
    expect(needsPublishUrlBackfill({ status: "published", publishUrl: "https://www.douyin.com/video/1" })).toBe(false);
  });

  it("存量脏数据(非 http(s))算「没链接」——它既点不开也解析不出作品 id", () => {
    expect(needsPublishUrlBackfill({ status: "published", publishUrl: "javascript:alert(1)" })).toBe(true);
  });

  it("没发布的稿子不出补记入口（那是「我已发布,确认」的活）", () => {
    expect(needsPublishUrlBackfill({ status: "publish_ready" })).toBe(false);
    expect(needsPublishUrlBackfill({ status: "draft", publishUrl: null })).toBe(false);
  });
});

describe("publishUrlPlatformWarning", () => {
  it("域名对得上平台 → 不吭声（含子域）", () => {
    expect(publishUrlPlatformWarning("https://www.douyin.com/video/123", "douyin")).toBeNull();
    expect(publishUrlPlatformWarning("https://mp.weixin.qq.com/s/abc", "wechat_mp")).toBeNull();
    expect(publishUrlPlatformWarning("https://xhslink.com/abc", "xiaohongshu")).toBeNull();
  });

  it("贴错平台 → 给一句提醒（非阻断，调用方照常允许提交）", () => {
    const w = publishUrlPlatformWarning("https://www.xiaohongshu.com/explore/abc", "douyin");
    expect(w).toContain("抖音");
    expect(w).toContain("xiaohongshu.com");
  });

  it("判不准的一律不吭声：非法链接、无平台、未登记平台", () => {
    expect(publishUrlPlatformWarning("javascript:alert(1)", "douyin")).toBeNull();
    expect(publishUrlPlatformWarning("https://example.com/a", null)).toBeNull();
    expect(publishUrlPlatformWarning("https://example.com/a", "some_new_platform")).toBeNull();
  });
});
