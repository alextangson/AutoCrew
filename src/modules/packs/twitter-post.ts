/**
 * X(Twitter) 短帖/Thread 赛道包 v1（IA v5 V5.4）。
 * X 的分发货币是转发与回复:单帖 280 单位(CJK×2),超限走 thread。
 * 语言跟随创作者声音(中文号写中文;英文受众场景由用户显式说明)。
 * reward 权重为提案起始值,回流数据成熟后调参。
 */
import type { TrackPack } from "./pack-schema.js";

export const TWITTER_POST_PACK: TrackPack = {
  id: "twitter_post",
  name: "X 短帖",
  version: 1,
  writerRole:
    "你是一名 X(Twitter) 内容作者,擅长把一个判断压缩成一条让人必须转发的短帖,或一条 3-5 楼的 thread。",
  reward: {
    default: {
      primary: "shares",
      weights: { views: 0.01, likes: 1, comments: 3, shares: 8, follows: 10 },
      note: "X 目标函数 = 转发主导 + 回复与涨粉(提案值,回流后调参)",
    },
  },
  hooks: [
    { type: "反常识判断", whenToUse: "一句话就能立住的反直觉结论" },
    { type: "数据震撼", whenToUse: "一个数字本身就是故事" },
    { type: "犀利站队", whenToUse: "行业争议里有明确立场可表" },
    { type: "第一手经历", whenToUse: "刚发生在自己身上的具体事" },
  ],
  structure: {
    hook: [
      "第一行即全部:时间线只展示前两行,第一行必须让目标受众停下",
      "禁用铺垫式开头;直接抛判断、数字或冲突",
    ],
    body: [
      "单帖优先:全文(含标题行)控制在 130 中文字符内,一个判断+一个依据",
      "内容装不下时写成 thread:3-5 楼,每楼 ≤120 中文字符、独立成立(单楼被转发也不断头)",
      "楼与楼之间用空行分段,不加楼号(排版层负责编号)",
      "具体名词与数字优先于形容词;不解释背景,直接给增量",
    ],
    cta: [
      "结尾一句站得住的判断或反问,引转发/回复;不要「关注我」式硬讨",
      "hashtags 最多 2 个,宁可不加",
    ],
  },
  selfReview: [
    "第一行单独发出去,还有人想点开吗?",
    "每一楼删掉一半字,信息还在吗?在就删。",
    "有没有一句值得别人截图转发的话?",
    "是不是在写「文章摘要」而不是「X 原生帖」?",
  ],
  platformAdjustments: {
    twitter: {
      chars: "单帖 ≤130 中文字符;thread 每楼 ≤120",
      style: "断言式短句;具体名词;零客套零铺垫",
    },
  },
  complianceNote:
    "合规口径=「符合平台规则的自然口吻」(PRD §6 红线 5):always-on humanizer/zh + sensitive-words 过滤,绝不表述为绕过检测/标识。",
};
