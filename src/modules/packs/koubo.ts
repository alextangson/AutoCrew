/**
 * 口播（知识类）赛道包 v1 — 内容抽取自 skills/write-script/SKILL.md 的口播 playbook，
 * reward 权重来自 2026-06-10 dogfood 发现（抖音 5s完播率更敏感；小红书无完播列）。
 * 权重是起始值：调参改这里，不改打分代码。
 * 调参注意：(a) views 项在 ~28000 播放时反超 35 分的 completion5s 项（当前数据峰值 8287，留意未来爆款）；
 * (b) 知识类高收藏率下 favorites 贡献可能超过 completion5s——primary 是报表强调口径，不等于得分主导。
 */
import type { TrackPack } from "./pack-schema.js";

export const KOUBO_PACK: TrackPack = {
  id: "koubo",
  name: "知识口播",
  // v2(2026-07-09 活人感重写):砍掉「5-8 点×80-150 字×论断→为什么→例子」的均匀
  // 节奏规格——规则约束出均值,活人味是方差;结构改为四模式任选+节奏起伏要求,
  // 罐头互动钩子(「你猜怎么着」)删除,自检从字数打勾改功能性检验。
  version: 2,
  reward: {
    default: {
      primary: "completionRate",
      weights: { completionRate: 15, favorites: 4, follows: 8, likes: 2, comments: 3, shares: 5, views: 0.01 },
      note: "口播目标函数 = 完播主导，播放保底（PRD §6：口播=完播）",
    },
    byPlatform: {
      douyin: {
        primary: "completion5s",
        weights: { completion5s: 8, completionRate: 15, favorites: 4, follows: 8, likes: 2, comments: 3, shares: 5, views: 0.01 },
        note: "5s完播率对钩子质量比全程完播更敏感（3-5min 视频全程完播自然只有 2-6%）",
      },
      xiaohongshu: {
        primary: "favorites",
        weights: { favorites: 6, follows: 10, likes: 2, comments: 3, shares: 5, views: 0.02 },
        note: "小红书导出无完播率列（2026-06-10 实战确认），用收藏+涨粉做代理信号",
      },
    },
  },
  hooks: [
    { type: "痛点", whenToUse: "受众有一个明显未解决的挫败" },
    { type: "悬念", whenToUse: "选题有反直觉真相或惊人数据" },
    { type: "理想状态", whenToUse: "选题贩卖一个值得向往的结果" },
    { type: "情绪共鸣", whenToUse: "选题触及身份认同、归属或抱负" },
    { type: "反差", whenToUse: "普遍认知与现实之间有清晰落差" },
  ],
  structureModes: [
    { id: "single-point", name: "单点打穿", guide: "全篇只讲透一个判断：核心论断 → 为什么多数人想不到/做不到 → 一个完整案例展开 → 怎么用" },
    { id: "listicle", name: "清单盘点", guide: "3-6 个并列信息点，每点必须有独立的信息增量；点与点长短悬殊没关系，信息密度决定篇幅" },
    { id: "story", name: "亲历复盘", guide: "从一段具体经历/踩坑切入，讲清当时的判断和转折，最后提炼一个可带走的结论" },
    { id: "myth-busting", name: "反认知纠偏", guide: "先立一个大家都信的说法，用事实和数据推翻它，给出正确的替代判断" },
  ],
  structure: {
    hook: [
      "1-3 句，只选一种最强钩子类型，3 秒内让目标受众觉得「这在说我」",
      "绝不以「哈喽大家好」「你有没有想过」等通用问候开头",
    ],
    body: [
      "按选中的结构模式展开，正文合计 800-1500 字",
      "节奏要有起伏：长短句交替，最重要的判断可以一句话单独成段；段落长短应当明显不同，禁止每段等长等构的排比腔",
      "别把最好的料堆在前面，至少留一个打破预期的转折在中后段",
      "每个论断都落到具体：例子、数字、场景、对话，至少 2 处来自调研的数据点",
      "像跟一个朋友讲你刚想明白的事：允许自然的插话和口语转折，不写议论文腔",
      "互动引导只在真有悬念处用、从内容里自然长出来；禁止「你猜怎么着」这类与内容无关的套路填充",
    ],
    cta: [
      "1-2 句，引导一个具体动作（收藏/评论/关注）",
      "必须连接内容价值——「收藏这条，下次用得上」优于「觉得有用就点赞」",
    ],
  },
  selfReview: [
    "随机读三段，能听出是同一个人在说话吗（对照声音样本）？",
    "把开头 3 句删掉，全文是否明显变弱（钩子真的在干活）？",
    "有没有两段以上等长等构连排（排比腔 = AI 指纹）？",
    "至少 2 个具体例子或场景、2 个调研数据点（不是空泛断言）？",
    "有非显而易见的洞察或转折？",
    "无通用问候、无议论文段落；正文纯文本、空行分段（无 markdown 标题）？",
    "标题在平台字数限制内、话题标签相关？",
  ],
  platformAdjustments: {
    xiaohongshu: { chars: "300-1000", style: "emoji 丰富、口语化，话题标签置尾（5-15 个）", maxChars: 1000 },
    douyin: { chars: "脚本格式", style: "纯口播正文，不写画面/字幕条/镜头标注；3 秒内出钩子" },
    wechat_mp: { chars: "1500-3000", style: "每 300-500 字一个小标题，结构感更强", maxChars: 3000 },
    wechat_video: { chars: "300-800", style: "教育向语气，附文字总结", maxChars: 800 },
    bilibili: { chars: "500-2000", style: "年轻化表达，可以用梗，【】标注类型", maxChars: 2000 },
  },
  complianceNote: "合规口径=「符合平台规则的自然口吻」（PRD §6 红线 5）：always-on humanizer/zh + sensitive-words 过滤，绝不表述为绕过检测/标识。",
};
