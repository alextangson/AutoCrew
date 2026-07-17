/**
 * text-platform-packs.test.ts — X/Reddit/头条 三图文平台包（IA v5 V5.4）
 */
import { describe, it, expect } from "vitest";
import { getPack, getPackForPlatform } from "./index.js";
import { TWITTER_POST_PACK } from "./twitter-post.js";
import { REDDIT_POST_PACK } from "./reddit-post.js";
import { TOUTIAO_ARTICLE_PACK } from "./toutiao-article.js";
import { KOUBO_PACK } from "./koubo.js";
import { formatForClipboard } from "../publish/clipboard-publisher.js";

describe("三图文平台包注册与路由", () => {
  it("twitter/reddit/toutiao → 各自专包;视频平台仍回退口播", () => {
    expect(getPack("twitter_post")).toBe(TWITTER_POST_PACK);
    expect(getPackForPlatform("twitter")).toBe(TWITTER_POST_PACK);
    expect(getPackForPlatform("reddit")).toBe(REDDIT_POST_PACK);
    expect(getPackForPlatform("toutiao")).toBe(TOUTIAO_ARTICLE_PACK);
    expect(getPackForPlatform("douyin")).toBe(KOUBO_PACK);
    expect(getPackForPlatform("wechat_video")).toBe(KOUBO_PACK);
  });

  it("头条包硬门:1000/2 + 反模式(配图不在写稿阶段);X/Reddit 无硬门(短文自审)", () => {
    const g = TOUTIAO_ARTICLE_PACK.qualityGate!;
    expect(g.minChars).toBe(1000);
    expect(g.minDataPoints).toBe(2);
    expect(g.minImageTags).toBeUndefined();
    for (const p of g.bannedHookPatterns!) expect(() => new RegExp(p)).not.toThrow();
    expect(TWITTER_POST_PACK.qualityGate).toBeUndefined();
    expect(REDDIT_POST_PACK.qualityGate).toBeUndefined();
  });

  it("reward 不变量:primary 在 weights 内且为正(三包)", () => {
    for (const pack of [TWITTER_POST_PACK, REDDIT_POST_PACK, TOUTIAO_ARTICLE_PACK]) {
      const r = pack.reward.default;
      expect(r.weights[r.primary], pack.id).toBeGreaterThan(0);
    }
  });
});

describe("三平台剪贴板格式", () => {
  it("twitter:短帖单发不分楼;长帖自动分楼带编号,CJK 按 2 单位计", () => {
    const short = formatForClipboard("twitter", "一个判断", "两句依据。", ["AI"]);
    expect(short.formattedBody).not.toContain("1/ ");
    expect(short.formattedBody).toContain("#AI");

    const longBody = Array.from({ length: 6 }, (_, i) => `第${i + 1}段观点,每段都有五十个左右的中文字符来撑长度,确保总量远超单帖上限继续往下写足字数。`).join("\n\n");
    const long = formatForClipboard("twitter", "长判断标题", longBody, ["AI", "工程", "多余标签"]);
    expect(long.formattedBody).toContain("1/ ");
    expect(long.formattedBody).toContain("2/ ");
    expect(long.formattedBody).toContain("下一楼");
    // hashtag 只保留 2 个且只在最后一楼
    expect(long.formattedBody).not.toContain("#多余标签");
  });

  it("reddit:无 hashtag;title+markdown 正文原样;tips 提社区规则", () => {
    const out = formatForClipboard("reddit", "How we cut 100k LOC", "## data\n- a\n- b", ["ignored"]);
    expect(out.copyText).toContain("How we cut 100k LOC");
    expect(out.copyText).not.toContain("#ignored");
    expect(out.tips.join("")).toContain("subreddit");
    expect(out.publishUrl).toContain("reddit.com/submit");
  });

  it("toutiao:标题+正文;发布地址指向头条号后台", () => {
    const out = formatForClipboard("toutiao", "标题", "正文", []);
    expect(out.copyText).toBe("标题\n\n正文");
    expect(out.publishUrl).toContain("mp.toutiao.com");
  });
});
