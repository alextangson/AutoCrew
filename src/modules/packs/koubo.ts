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
  version: 1,
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
  structure: {
    hook: [
      "1-3 句，只选一种最强钩子类型",
      "绝不以「哈喽大家好」「你有没有想过」等通用问候开头",
    ],
    body: [
      "5-8 个信息点，每点：论断 → 为什么成立 → 具体例子",
      "每点 80-150 字，正文合计 800-1500 字",
      "信息点递进展开——别把最好的料堆在前面",
      "包含 1-2 个打破预期的转折",
      "包含 1-2 个互动钩子（提问、「你猜怎么着」、评论引导）",
      "禁止议论文式长段落：短句，一句一个意思",
    ],
    cta: [
      "1-2 句，引导一个具体动作（收藏/评论/关注）",
      "必须连接内容价值——「收藏这条，下次用得上」优于「觉得有用就点赞」",
    ],
  },
  selfReview: [
    "全文 800 字以上？",
    "至少 2 个具体例子或场景（不是空泛断言）？",
    "有非显而易见的洞察或转折？",
    "语气符合 STYLE.md 画像？",
    "无通用问候、无议论文段落？",
    "正文纯文本、空行分段（无 markdown 标题）？",
    "标题在平台字数限制内？",
    "话题标签已生成且相关？",
    "至少 2 个来自调研的数据点？",
    "遵循了确认过的大纲结构？",
  ],
  platformAdjustments: {
    xiaohongshu: { chars: "300-1000", style: "emoji 丰富、口语化，话题标签置尾（5-15 个）" },
    douyin: { chars: "脚本格式", style: "[画面] + [口播] + [字幕条]，3 秒内出钩子" },
    wechat_mp: { chars: "1500-3000", style: "每 300-500 字一个小标题，结构感更强" },
    wechat_video: { chars: "300-800", style: "教育向语气，附文字总结" },
    bilibili: { chars: "500-2000", style: "年轻化表达，可以用梗，【】标注类型" },
  },
  complianceNote: "合规口径=「符合平台规则的自然口吻」（PRD §6 红线 5）：always-on humanizer/zh + sensitive-words 过滤，绝不表述为绕过检测/标识。",
};
