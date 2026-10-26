/**
 * 平台能力表（全媒体 spec §8 Phase 1 #1）：每个平台的形态、语言、封面、计数口径、上限、发布包字段、
 * 数据回流与发布通道只在这里写一次，stage-guard / 把关 / 预检 / 发布包 / 封面 / ego-lite / 数据页 / 回流都从这里派生。
 *
 * 零 import：storage 层（stage-guard）也要读它，放进任何会反向 import local-store 的文件都会成环。
 * 前端 frontend/src/lib.ts 的 PLATFORM_CAPS 是本表的镜像（只抄前端用到的字段），platform-caps.test.ts 核两边同值。
 *
 * 语言字段决定「一条视频默认发哪些平台」：中文成片的发布包只列 zh 视频平台，youtube / x 只属于英文版稿件
 * （派生出来的 en_edition），中文线不会因为表里多了两个平台就去要英文产物。
 */

export type PlatformKind = "video" | "article";
export type PlatformLanguage = "zh" | "en";
/** cjk_weighted = 中文 1 字、英文数字半字、空格不计（中文平台后台口径）；plain = 字符数（英文平台） */
export type TitleCounter = "cjk_weighted" | "plain";
/** browser_pull = 自动回流（浏览器拉数）；bind_only = 只能手动绑作品 / 认领；unsupported = 不回流 */
export type MetricsSupport = "browser_pull" | "bind_only" | "unsupported";
export type PublishChannel = "ego_lite" | "wechat_api";

export interface PlatformCaps {
  label: string;
  kind: PlatformKind;
  language: PlatformLanguage;
  /** 发布时要上传的封面比例，首项 = 默认主比例 */
  coverRatios: string[];
  /** 平台上传界面能收的比例（设置页可选范围） */
  coverSlots: string[];
  /** 预检要求封面评审定稿 */
  coverRequired: boolean;
  titleCounter: TitleCounter;
  /** 发布标题上限；不写 = 沿用通用回退 30（公众号历来如此） */
  titleMax?: number;
  /** 正文（无发布包时）下限 */
  bodyMin?: number;
  /** 文案 / 正文上限；不写 = 不设硬上限 */
  bodyMax?: number;
  /** 引擎生成发布文案时注入的平台纪律 */
  captionRule?: string;
  /** 发布包必须有的字段（Phase 3 交英文包时按这里校验） */
  kitFields: string[];
  metrics: MetricsSupport;
  publishChannel: PublishChannel;
  /** ego-lite 打开的发布页 */
  publishUrl?: string;
  /** 精确认名的别名（小写）：计划里的 platform 值按它归一 */
  aliases: string[];
  /**
   * 可以在一段话里按子串认出的别名（把关用它判一条规则「只点名了哪些平台」）。英文平台留空：
   * 「文案不能出现 YouTube 字样」这种规则只是提到这个词，不是只管 YouTube；当成点名会让四个中文平台漏掉它（Codex 审 P2）。
   * 英文平台只认计划里精确写的平台值（aliases）。
   */
  textAliases: string[];
}

const ZH_KIT = ["post_title", "caption", "cover_text"];

/** 表的顺序 = 各处列平台的顺序（数据页列、错误提示） */
const TABLE = {
  douyin: {
    label: "抖音", kind: "video", language: "zh", coverRatios: ["3:4", "4:3"], coverSlots: ["3:4", "4:3"], coverRequired: true,
    titleCounter: "cjk_weighted", titleMax: 30, bodyMin: 100,
    captionRule: "发布文案 ≤300 字:首句钩子(时间线只见首行),3-5 个话题标签内联在文末",
    kitFields: ZH_KIT, metrics: "browser_pull", publishChannel: "ego_lite",
    publishUrl: "https://creator.douyin.com/creator-micro/content/upload",
    aliases: ["douyin", "tiktok", "抖音"], textAliases: ["douyin", "tiktok", "抖音"],
  },
  wechat_video: {
    label: "视频号", kind: "video", language: "zh", coverRatios: ["3:4", "4:3"], coverSlots: ["3:4", "4:3"], coverRequired: true,
    titleCounter: "cjk_weighted", titleMax: 22, bodyMin: 100, bodyMax: 800,
    captionRule: "发布文案 100-300 字:一句钩子+一句价值点,2-4 个话题标签",
    kitFields: ZH_KIT, metrics: "browser_pull", publishChannel: "ego_lite",
    publishUrl: "https://channels.weixin.qq.com/platform/post/create",
    aliases: ["wechat_video", "shipinhao", "channels", "视频号"], textAliases: ["wechat_video", "shipinhao", "channels", "视频号"],
  },
  xiaohongshu: {
    label: "小红书", kind: "video", language: "zh", coverRatios: ["3:4"], coverSlots: ["3:4", "4:3", "1:1"], coverRequired: true,
    titleCounter: "cjk_weighted", titleMax: 20, bodyMin: 200, bodyMax: 1000,
    captionRule: "发布文案 300-800 字:口语化短段落,可用 emoji,5-15 个话题标签放文末",
    kitFields: ZH_KIT, metrics: "browser_pull", publishChannel: "ego_lite",
    publishUrl: "https://creator.xiaohongshu.com/publish/publish",
    aliases: ["xiaohongshu", "小红书", "rednote", "xhs", "红书"], textAliases: ["xiaohongshu", "小红书", "rednote", "xhs", "红书"],
  },
  bilibili: {
    label: "B站", kind: "video", language: "zh", coverRatios: ["4:3"], coverSlots: ["4:3", "16:9"], coverRequired: true,
    titleCounter: "cjk_weighted", titleMax: 40, bodyMin: 200, bodyMax: 2000,
    captionRule: "发布文案(简介)200-500 字:讲清这期讲什么+能带走什么,3-6 个标签",
    kitFields: ZH_KIT, metrics: "browser_pull", publishChannel: "ego_lite",
    publishUrl: "https://member.bilibili.com/platform/upload/video/frame",
    aliases: ["bilibili", "哔哩哔哩", "b站", "b 站"], textAliases: ["bilibili", "哔哩哔哩", "b站", "b 站"],
  },
  wechat_mp: {
    label: "公众号", kind: "article", language: "zh", coverRatios: ["2.35:1"], coverSlots: ["2.35:1"], coverRequired: false,
    // 正文上限 4000（spec §7 #8：长文 2500–4000 字）；标题上限沿用回退 30
    titleCounter: "cjk_weighted", bodyMin: 800, bodyMax: 4000,
    kitFields: [], metrics: "browser_pull", publishChannel: "wechat_api",
    aliases: ["wechat_mp", "公众号"], textAliases: [],
  },
  youtube: {
    // YouTube 标题 ≤100 字符、描述 ≤5000 字符（YouTube Studio 上限）；按字符计，不做中文半字折算
    label: "YouTube", kind: "video", language: "en", coverRatios: ["16:9"], coverSlots: ["16:9"], coverRequired: true,
    titleCounter: "plain", titleMax: 100, bodyMax: 5000,
    captionRule: "Description: first two lines are the hook (shown above the fold), then what the viewer takes away, chapters, 3-5 hashtags",
    kitFields: ["post_title", "caption", "tags", "chapters", "ai_disclosure"], metrics: "unsupported", publishChannel: "ego_lite",
    publishUrl: "https://studio.youtube.com",
    aliases: ["youtube", "yt", "油管"], textAliases: [],
  },
  x: {
    // X 帖子正文 ≤280 字符：非 Premium 账号的基线（Premium 可发长帖，这里按基线保守卡）；X 视频帖没有独立标题，
    // 发布标题就是帖子正文，所以标题和正文同一个上限
    label: "X（推特）", kind: "video", language: "en", coverRatios: ["16:9"], coverSlots: ["16:9"], coverRequired: true,
    titleCounter: "plain", titleMax: 280, bodyMax: 280,
    captionRule: "Post text ≤280 chars: one hook line, one takeaway, 1-2 hashtags",
    kitFields: ["post_text"], metrics: "unsupported", publishChannel: "ego_lite",
    publishUrl: "https://x.com/compose/post",
    aliases: ["x", "twitter", "推特"], textAliases: [],
  },
} satisfies Record<string, PlatformCaps>;

export type PlatformId = keyof typeof TABLE;
export const PLATFORM_CAPS: Readonly<Record<PlatformId, PlatformCaps>> = TABLE;
export const PLATFORM_IDS = Object.keys(PLATFORM_CAPS) as PlatformId[];

/** 旧数据里的简写（xhs）归到规范名；认不出返回 null */
export function capsOf(platform?: string | null): PlatformCaps | null {
  if (!platform) return null;
  const id = platform === "xhs" ? "xiaohongshu" : platform;
  return (PLATFORM_CAPS as Record<string, PlatformCaps>)[id] ?? null;
}

/** 按条件筛平台，保持表顺序 */
export function platformsWhere(pred: (c: PlatformCaps, id: PlatformId) => boolean): PlatformId[] {
  return PLATFORM_IDS.filter((id) => pred(PLATFORM_CAPS[id], id));
}

/** 全部视频平台（含英文） */
export const ALL_VIDEO_PLATFORMS: readonly PlatformId[] = platformsWhere((c) => c.kind === "video");

/** 有数据回流（自动拉或手动绑）的平台；YouTube / X 明确 unsupported，不在里面 */
export const METRICS_PLATFORMS: readonly PlatformId[] = platformsWhere((c) => c.metrics !== "unsupported");

/** 某种语言的视频平台：一条视频默认的发布平台清单只取与它同语言的 */
export function videoPlatformsFor(language: PlatformLanguage): PlatformId[] {
  return platformsWhere((c) => c.kind === "video" && c.language === language);
}

/** 稿件平台的语言；认不出按中文（历来所有稿都是中文） */
export function languageOf(platform?: string | null): PlatformLanguage {
  return capsOf(platform)?.language ?? "zh";
}

/** 一条稿默认的发布平台：与稿件平台同语言的视频平台 */
export function kitPlatformsFor(contentPlatform?: string | null): PlatformId[] {
  return videoPlatformsFor(languageOf(contentPlatform));
}

/** 标题计数：按平台口径（中文平台加权，英文平台按字符） */
export function countTitleChars(platform: string, title: string): number {
  if (capsOf(platform)?.titleCounter === "plain") return [...title].length;
  return cjkWeightedChars(title);
}

/** 计数口径的人话（错误提示里说清怎么数的） */
export function titleCountNote(platform: string): string {
  return capsOf(platform)?.titleCounter === "plain" ? "按字符计" : "中文 1 字、英文数字半字";
}

/** 中文平台口径：中文 1 字，英文 / 数字按半字折算，空格不计 */
export function cjkWeightedChars(title: string): number {
  const cjkCount = (title.match(/[一-鿿]/g) ?? []).length;
  const otherCount = title.replace(/[一-鿿]/g, "").replace(/\s/g, "").length;
  return cjkCount + Math.ceil(otherCount / 2);
}
