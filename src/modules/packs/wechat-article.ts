/**
 * 公众号深度图文赛道包 v1 — 内容移植自 muse-social article-derivation SKILL
 * （P0 附录 0-2/0-3 处置清单）。Quality Gate 阈值源自原 5 项硬门禁中可判定的
 * 4 项（案例数不可判定，留在 body 规则句里由模型自查）。
 * 字数默认 1500-2000（创始人 2026-07-08 裁决）：原 5000-6000 字需 ~4 分钟长流，
 * 超出 relay 稳定阈值；密度约束（案例/数据）随字数等比缩放，改回长文时一起调。
 * 配图不在写稿阶段：初稿零 [IMAGE:] 标记，过审后由 AI 选位（suggest-images）负责。
 * reward 权重为提案起始值：公众号无完播概念，阅读保底、转发/在看与涨粉主导，
 * 回流数据成熟后调参改这里。
 */
import type { TrackPack } from "./pack-schema.js";

export const WECHAT_ARTICLE_PACK: TrackPack = {
  id: "wechat_article",
  name: "公众号深度图文",
  version: 1,
  writerRole:
    "你是一名公众号深度图文写手，擅长把一个选题写成 1500-2000 字、像朋友聊天一样好读、但论证扎实的文章。",
  reward: {
    default: {
      primary: "views",
      weights: { views: 0.02, shares: 6, favorites: 4, follows: 10, likes: 2, comments: 4 },
      note: "公众号目标函数 = 阅读保底 + 转发/在看与涨粉主导（提案值，回流后调参）",
    },
  },
  hooks: [
    { type: "反常识判断", whenToUse: "选题存在与普遍认知相反的结论" },
    { type: "数据震撼", whenToUse: "有一个数字大到或反差到值得单独开头" },
    { type: "场景代入", whenToUse: "读者有一个高频具体场景可以瞬间代入" },
    { type: "痛点", whenToUse: "受众有一个明显未解决的挫败" },
    { type: "张力冲突", whenToUse: "两个都对的事实放在一起互相打架" },
  ],
  structureModes: [
    { id: "thesis", name: "结论先行", guide: "第一段抛出核心判断，正文逐层给证据与推理" },
    { id: "autopsy", name: "现象解剖", guide: "从一个具体现象/事件切入，层层拆解背后成因" },
    { id: "tension", name: "张力型", guide: "先立普遍认知，再用事实推翻，在冲突中展开论证" },
    { id: "narrative", name: "故事+洞察", guide: "以一段真实经历/案例开场，从中提炼方法论" },
  ],
  structure: {
    hook: [
      "前 3 句制造好奇心缺口或情绪共鸣：痛点/场景/反常识直接切入",
      "禁用开头：「随着…」「近年来…」「在…领域…」「众所周知…」「不可否认…」",
    ],
    body: [
      "1500-2000 字：篇幅精炼但论证完整，聚焦一个核心判断，不摊大饼、不注水",
      "至少 1 个具体案例（公司名/人名 + 事件），至少 3 处数据引用（数字、百分比、时间点、金额）",
      "口语化，像朋友聊天；短句为主；每 300 字左右一个呼吸点（换段）",
      "给出一个可带走的方法论或判断框架；至少点出一处反面观点或风险",
      "正文不用 markdown 标题/列表语法（公众号不支持），可用加粗与分隔线",
    ],
    cta: [
      "结尾 1-2 句引导语：引导转发或留言，必须连接内容价值",
      "hashtags 填 3-5 个文章关键词（用作公众号标签，不带 # 也可）",
    ],
  },
  selfReview: [
    "通读全文，是否像一篇有完整论证的独立文章而非要点罗列？",
    "至少 2 处非显而易见的信息增量？",
    "非技术读者能否顺畅读完？",
    "开头 3 句拿掉后文章是否明显变弱（钩子真的在干活）？",
  ],
  platformAdjustments: {
    wechat_mp: {
      chars: "1500-2000",
      style: "深度图文；口语化短句",
    },
  },
  qualityGate: {
    minChars: 1500,
    maxChars: 2000,
    minDataPoints: 3,
    bannedHookPatterns: ["^随着", "^近年来", "^在.{1,12}(领域|行业)", "^众所周知", "^不可否认"],
    maxRepairRounds: 2,
  },
  coverPromptTemplate:
    "Notion 插画风格，比例 2.35:1，色彩鲜明对比强烈。\n主题：{theme}。\n主视觉居中偏左，右侧留标题区。\n1-2 个简洁卡通形象，大量留白，突出核心信息。\n标题文字 8 字以内，简体中文，字体与插画协调。\n高对比配色（橙黄/蓝紫/红黑），悬念或数字钩子元素。",
  complianceNote:
    "合规口径=「符合平台规则的自然口吻」（PRD §6 红线 5）：always-on humanizer/zh + sensitive-words 过滤，绝不表述为绕过检测/标识。",
};
