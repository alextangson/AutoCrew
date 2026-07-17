/**
 * 今日头条图文赛道包 v1（IA v5 V5.4）。
 * 头条是信息流推荐分发:标题拿推荐、首图定点击、段落短保完读。
 * 与公众号深度图文同为图文但分发逻辑不同:头条读者是「刷到的陌生人」,
 * 不是「关注你的读者」——开头必须 3 秒内给出留下来的理由。
 */
import type { TrackPack } from "./pack-schema.js";

export const TOUTIAO_ARTICLE_PACK: TrackPack = {
  id: "toutiao_article",
  name: "头条图文",
  version: 1,
  writerRole:
    "你是一名今日头条图文作者,擅长把一个判断写成让信息流里的陌生人停下、读完、点关注的文章。",
  reward: {
    default: {
      primary: "views",
      weights: { views: 0.02, likes: 1, comments: 3, shares: 4, follows: 8 },
      note: "头条目标函数 = 推荐量保底 + 评论互动与涨粉(提案值,回流后调参)",
    },
  },
  hooks: [
    { type: "数据震撼", whenToUse: "有一个大到反常的数字" },
    { type: "身边冲突", whenToUse: "普通人身边正在发生的具体变化" },
    { type: "反常识判断", whenToUse: "与大众直觉相反且能论证的结论" },
    { type: "热点解剖", whenToUse: "正在发酵的事件有信息增量可给" },
  ],
  structure: {
    hook: [
      "标题 20-30 字,含具体数字/冲突/悬念之一;不允许「震惊体」与虚假悬念",
      "开头 2 句给出「值得读完」的理由:结论前置或冲突前置",
      "禁用开头:「随着」「近年来」「众所周知」「在…领域」",
    ],
    body: [
      "1000-1800 字;每段 2-3 行,每 300 字左右一个小标题或呼吸点",
      "面向陌生读者:不预设背景知识,专业词第一次出现要用人话解释",
      "至少 2 处数据引用(数字/百分比/金额),至少 1 个具体案例",
      "观点句和事实句分开写;不堆形容词",
    ],
    cta: [
      "结尾 1-2 句:一个可评论的开放问题 + 引导关注(自然,不硬讨)",
      "hashtags 填 3-5 个文章关键词(用作头条话题,不带 # 也可)",
    ],
  },
  selfReview: [
    "标题单独刷到,会点吗?点进来 3 秒内知道为什么要读完吗?",
    "一个完全不懂这个领域的人能顺畅读完吗?",
    "有没有至少一处让人想评论反驳或补充的点?",
  ],
  platformAdjustments: {
    toutiao: {
      chars: "1000-1800",
      style: "信息流风格;短段落;小标题分节;面向陌生读者",
    },
  },
  qualityGate: {
    minChars: 1000,
    maxChars: 1800,
    minDataPoints: 2,
    bannedHookPatterns: ["^随着", "^近年来", "^在.{1,12}(领域|行业)", "^众所周知", "^不可否认"],
    maxRepairRounds: 2,
  },
  coverPromptTemplate:
    "写实风格资讯配图,比例 16:9,画面具体、信息量足。\n主题:{theme}。\n主视觉居中,色彩明快对比强,无文字或极少文字。",
  complianceNote:
    "合规口径=「符合平台规则的自然口吻」(PRD §6 红线 5):always-on humanizer/zh + sensitive-words 过滤,绝不表述为绕过检测/标识;不写震惊体不造谣蹭热点。",
};
