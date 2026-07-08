/**
 * wechat-article.test.ts — 公众号包形状 + 平台路由（PRD-v4 §4.3）
 */
import { describe, it, expect } from "vitest";
import { WECHAT_ARTICLE_PACK } from "./wechat-article.js";
import { KOUBO_PACK } from "./koubo.js";
import { getPack, getPackForPlatform } from "./index.js";

describe("wechat article pack", () => {
  it("已注册且按平台路由：wechat_mp → 图文包，其余 → 口播包", () => {
    expect(getPack("wechat_article")).toBe(WECHAT_ARTICLE_PACK);
    expect(getPackForPlatform("wechat_mp")).toBe(WECHAT_ARTICLE_PACK);
    expect(getPackForPlatform("douyin")).toBe(KOUBO_PACK);
    expect(getPackForPlatform("xiaohongshu")).toBe(KOUBO_PACK);
    expect(getPackForPlatform("bilibili")).toBe(KOUBO_PACK);
  });

  it("Quality Gate 阈值 = article-derivation 硬门禁（5000/5/4 + 反模式）", () => {
    const g = WECHAT_ARTICLE_PACK.qualityGate;
    expect(g).toBeDefined();
    expect(g!.minChars).toBe(5000);
    expect(g!.minDataPoints).toBe(5);
    expect(g!.minImageTags).toBe(4);
    expect(g!.bannedHookPatterns!.length).toBeGreaterThanOrEqual(5);
    for (const p of g!.bannedHookPatterns!) {
      expect(() => new RegExp(p), `非法正则: ${p}`).not.toThrow();
    }
  });

  it("reward 不变量：primary 在 weights 内且权重为正有限数", () => {
    const r = WECHAT_ARTICLE_PACK.reward.default;
    expect(r.weights[r.primary]).toBeGreaterThan(0);
    for (const [key, w] of Object.entries(r.weights)) {
      expect(Number.isFinite(w), `${key} 权重非有限数`).toBe(true);
      expect(w, `${key} 权重必须为正`).toBeGreaterThan(0);
    }
  });

  it("封面模板带 {theme} 占位与 2.35:1 比例；结构模式 ≥4 种", () => {
    expect(WECHAT_ARTICLE_PACK.coverPromptTemplate).toContain("{theme}");
    expect(WECHAT_ARTICLE_PACK.coverPromptTemplate).toContain("2.35:1");
    expect(WECHAT_ARTICLE_PACK.structureModes!.length).toBeGreaterThanOrEqual(4);
  });
});
