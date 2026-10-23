/**
 * 公众号「视频改写长文」赛道包（全媒体 spec §3.2、Phase 2a）：从一条审过的中文成片派生的公众号文章专用。
 *
 * 和普通公众号包（wechat-article.ts，1500-2000 字）分开：只有 derivedFrom.kind = wechat_article 的稿走它，
 * 普通公众号稿行为不变。篇幅 2500–4000 字不做写稿硬门（硬门会把稿打回修复轮，创始人没法用原话放行）——
 * 超出范围在图文审阅里标出来，创始人可以用原话放行（modules/wechat-article/package.ts）。
 * 配图在写稿时就标好：[IMAGE: gen: …] 生成图 / [IMAGE: web: …] 官方来源或我们自己截的公开页面。
 */
import type { TrackPack } from "./pack-schema.js";
import { WECHAT_ARTICLE_PACK } from "./wechat-article.js";

export const WECHAT_VIDEO_ARTICLE_PACK: TrackPack = {
  ...WECHAT_ARTICLE_PACK,
  id: "wechat_video_article",
  name: "公众号长文（由视频改写）",
  version: 1,
  writerRole:
    "你是一名公众号长文写手：把一条已经剪好的口播视频（以成片转写为底稿）改写成 2500-4000 字、好读、能被转发的公众号文章。观点和事实以成片和调研台账为准，不另起炉灶。",
  structure: {
    hook: [
      "前 3 行就给读者一个继续读的理由：一个具体场景、一个反常识判断或一个数字，直接切入，不铺背景",
      "禁用开头：「随着…」「近年来…」「在…领域…」「众所周知…」「不可否认…」",
    ],
    body: [
      "2500-4000 字（中文字符）。底稿是成片转写：保留视频里的判断和例子，把口语里一句带过的地方展开讲透",
      "公众号爆款写法：小标题可扫读（每节一个小标题，读者只看小标题也知道全文在讲什么）；一节只讲一个意思",
      "每节至少一个具体案例或数据，只用成片里讲过的、或调研台账里有出处的；新查的引文必须先过 verify_quote 再写",
      "每节留一句能单独截图转发的金句：口语、带具体东西，不用「不是 X 是 Y」式对仗",
      "配图就地标记：[IMAGE: gen: 画面描述] = 生成图（概念示意、氛围图）；[IMAGE: web: 要找的图] = 官方来源图或我们自己截的公开页面（产品页、官方图表），交稿后由宿主截图并登记来源链接",
      "正文用 ## 小标题分节；可用加粗；不用列表堆砌要点",
    ],
    cta: [
      "结尾给读者一件今天就能做的事（一个步骤、一句可照抄的话、一个自查问题），不写空泛的号召",
      "交稿后用 autocrew_content wechat_article set_titles 交 3-5 个标题候选，供创始人挑；hashtags 填 3-5 个关键词",
    ],
  },
  selfReview: [
    "前 3 行拿掉后文章是否明显变弱（钩子真的在干活）？",
    "只看小标题能不能说出全文的主线？每节是不是只讲了一件事？",
    "每个案例 / 数字都能在成片转写或台账里找到出处吗？有没有新编的引文？",
    "结尾读者能带走一件马上能做的事吗？",
  ],
  platformAdjustments: {
    wechat_mp: { chars: "2500-4000", style: "长文；## 小标题分节；口语化短句" },
  },
  // 不设 minChars / maxChars：篇幅在图文审阅里标、可由创始人原话放行（见文件头）
  qualityGate: {
    minDataPoints: 3,
    bannedHookPatterns: WECHAT_ARTICLE_PACK.qualityGate?.bannedHookPatterns ?? [],
    maxRepairRounds: 2,
  },
};
