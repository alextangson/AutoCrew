/**
 * Reddit 帖子赛道包 v1（IA v5 V5.4）。
 * Reddit 的分发货币是讨论:标题决定生死,社区反感营销腔与自我推广。
 * 语言跟随目标 subreddit(英文社区写英文——由选题/用户指定;缺省跟随创作者声音)。
 */
import type { TrackPack } from "./pack-schema.js";

export const REDDIT_POST_PACK: TrackPack = {
  id: "reddit_post",
  name: "Reddit 帖子",
  version: 1,
  writerRole:
    "你是一名 Reddit 深度用户,擅长把实战经验写成引发真实讨论的帖子——分享者姿态,不是营销号姿态。",
  reward: {
    default: {
      primary: "comments",
      weights: { views: 0.01, likes: 2, comments: 6, favorites: 3 },
      note: "Reddit 目标函数 = 讨论主导(评论)+ upvote(提案值,回流后调参)",
    },
  },
  hooks: [
    { type: "经验复盘", whenToUse: "有一段可以完整复盘的真实经历(做成了/搞砸了)" },
    { type: "数据披露", whenToUse: "手里有别人拿不到的第一手数字" },
    { type: "求锤反问", whenToUse: "一个自己也没完全想通、社区会吵起来的问题" },
  ],
  structure: {
    hook: [
      "标题即全部:具体、诚实、包含结果或数字;禁止标题党与悬念钓鱼(社区会反噬)",
      "标题写成「我做了 X,结果 Y」或「为什么 X 是 Y」的形态",
    ],
    body: [
      "500-1500 字;markdown 排版(小标题/列表/加粗)",
      "分享者视角:讲自己做了什么、数据如何、错在哪——不下营销结论",
      "至少 2 处具体数字或可验证细节;来源可查",
      "预判 2-3 个社区会提的质疑,正文里直接回应",
      "禁止任何产品推广口吻;提到自己的项目要披露利益相关(disclosure)",
    ],
    cta: [
      "结尾抛一个真问题引讨论,不引流不带链接",
      "hashtags 留空或填 1-2 个主题词(Reddit 无 hashtag,仅作内部归档)",
    ],
  },
  selfReview: [
    "这帖像「用户分享」还是像「品牌软文」?像后者就重写。",
    "标题里的承诺,正文兑现了吗?",
    "有没有让人想在评论区反驳/补充的点?没有就没有讨论。",
    "利益相关披露了吗?",
  ],
  platformAdjustments: {
    reddit: {
      chars: "500-1500",
      style: "markdown;分享者语气;数据与细节优先;零营销腔",
    },
  },
  complianceNote:
    "合规口径=「符合平台与社区规则的自然口吻」:先读目标 subreddit 规则;always-on sensitive-words 过滤;绝不表述为绕过检测/标识。",
};
