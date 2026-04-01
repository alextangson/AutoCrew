/**
 * Multi-Platform Title & Hashtag Generator
 *
 * Generates platform-native title variants and hashtag suggestions
 * based on each platform's conventions and character limits.
 *
 * PRD §14.2: "各版本的标题和 hashtag 按平台独立生成"
 */

// --- Types ---

export interface PlatformRules {
  name: string;
  /** Display name in Chinese */
  displayName: string;
  /** Max title length (chars) */
  maxTitleLength: number;
  /** Recommended title length range */
  titleLengthRange: [number, number];
  /** Max hashtags */
  maxHashtags: number;
  /** Hashtag format */
  hashtagPrefix: string;
  /** Platform-specific title tips */
  titleTips: string[];
  /** Common high-performing hashtag patterns */
  hotHashtagPatterns: string[];
}

export interface TitleVariant {
  title: string;
  style: "hook" | "list" | "question" | "story" | "direct";
  /** Why this variant works for the platform */
  note: string;
}

export interface HashtagSuggestion {
  tag: string;
  /** "topic" = content-related, "trending" = platform trend, "niche" = audience-specific */
  type: "topic" | "trending" | "niche";
}

export interface PlatformTitleResult {
  platform: string;
  titles: TitleVariant[];
  hashtags: HashtagSuggestion[];
  tips: string[];
}

// --- Platform Rules ---

const PLATFORM_RULES: Record<string, PlatformRules> = {
  xhs: {
    name: "xhs",
    displayName: "小红书",
    maxTitleLength: 20,
    titleLengthRange: [10, 18],
    maxHashtags: 10,
    hashtagPrefix: "#",
    titleTips: [
      "用 emoji 开头增加视觉吸引力",
      "数字 + 结果型标题表现最好",
      "避免标题党，小红书会限流",
      "口语化、第一人称更亲切",
    ],
    hotHashtagPatterns: [
      "干货分享", "经验分享", "避坑指南", "真实体验",
      "好物推荐", "自我提升", "效率工具", "学习打卡",
    ],
  },
  douyin: {
    name: "douyin",
    displayName: "抖音",
    maxTitleLength: 30,
    titleLengthRange: [8, 25],
    maxHashtags: 5,
    hashtagPrefix: "#",
    titleTips: [
      "前 3 秒决定完播率，标题要制造悬念",
      "用「没想到」「居然」等反转词",
      "数字型标题点击率高",
      "可以用 | 分隔主副标题",
    ],
    hotHashtagPatterns: [
      "涨知识", "干货", "必看", "真相",
      "生活小妙招", "职场", "创业", "副业",
    ],
  },
  wechat_mp: {
    name: "wechat_mp",
    displayName: "微信公众号",
    maxTitleLength: 64,
    titleLengthRange: [15, 40],
    maxHashtags: 3,
    hashtagPrefix: "#",
    titleTips: [
      "公众号标题可以更长，信息量更大",
      "用「：」分隔前后半句制造节奏",
      "数据型标题增加可信度",
      "避免全大写或过多感叹号",
    ],
    hotHashtagPatterns: [
      "深度", "观点", "行业分析", "趋势",
    ],
  },
  wechat_video: {
    name: "wechat_video",
    displayName: "视频号",
    maxTitleLength: 30,
    titleLengthRange: [10, 25],
    maxHashtags: 5,
    hashtagPrefix: "#",
    titleTips: [
      "视频号用户偏成熟，标题要稳重",
      "避免过度网感，保持专业感",
      "可以用提问式引发评论",
    ],
    hotHashtagPatterns: [
      "知识分享", "行业洞察", "职场经验", "创业心得",
    ],
  },
  bilibili: {
    name: "bilibili",
    displayName: "B站",
    maxTitleLength: 80,
    titleLengthRange: [15, 50],
    maxHashtags: 5,
    hashtagPrefix: "#",
    titleTips: [
      "B站标题可以更长更详细",
      "用【】标注视频类型（如【干货】【避坑】）",
      "年轻化表达，可以用梗",
      "副标题补充信息量",
    ],
    hotHashtagPatterns: [
      "干货", "教程", "测评", "避坑",
      "知识区", "科技", "生活", "学习",
    ],
  },
};

// Alias
PLATFORM_RULES["xiaohongshu"] = PLATFORM_RULES["xhs"];

/**
 * Get platform rules. Returns null if platform is unknown.
 */
export function getPlatformRules(platform: string): PlatformRules | null {
  return PLATFORM_RULES[platform] || null;
}

/**
 * Generate title variants for a specific platform.
 *
 * Takes a base title/topic and produces 3-5 platform-optimized variants.
 * This is a rule-based generator — the AI agent can use these as starting
 * points and refine further.
 */
export function generateTitleVariants(
  baseTopic: string,
  platform: string,
  opts?: { keyword?: string },
): TitleVariant[] {
  const rules = PLATFORM_RULES[platform];
  if (!rules) return [{ title: baseTopic, style: "direct", note: "未知平台，返回原标题" }];

  const keyword = opts?.keyword || "";
  const variants: TitleVariant[] = [];
  const [minLen, maxLen] = rules.titleLengthRange;

  // 1. Hook style — emotional trigger
  const hookTitle = buildHookTitle(baseTopic, maxLen);
  if (hookTitle) {
    variants.push({ title: hookTitle, style: "hook", note: "情绪触发型，适合引发好奇" });
  }

  // 2. List style — number + result
  const listTitle = buildListTitle(baseTopic, keyword, maxLen);
  variants.push({ title: listTitle, style: "list", note: "数字型，点击率通常最高" });

  // 3. Question style
  const questionTitle = buildQuestionTitle(baseTopic, maxLen);
  variants.push({ title: questionTitle, style: "question", note: "提问型，引发思考和评论" });

  // 4. Story style (first person)
  const storyTitle = buildStoryTitle(baseTopic, maxLen);
  variants.push({ title: storyTitle, style: "story", note: "故事型，第一人称更有代入感" });

  // 5. Direct style — clean and informative
  let directTitle = baseTopic;
  if (directTitle.length > maxLen) directTitle = directTitle.slice(0, maxLen);
  variants.push({ title: directTitle, style: "direct", note: "直述型，清晰传达主题" });

  // Enforce length limits
  return variants
    .map((v) => ({
      ...v,
      title: v.title.length > rules.maxTitleLength ? v.title.slice(0, rules.maxTitleLength) : v.title,
    }))
    .filter((v) => v.title.length >= Math.min(minLen, 5));
}

/**
 * Generate hashtag suggestions for a platform.
 */
export function generateHashtags(
  topic: string,
  platform: string,
  tags: string[] = [],
): HashtagSuggestion[] {
  const rules = PLATFORM_RULES[platform];
  if (!rules) return tags.map((t) => ({ tag: `#${t}`, type: "topic" as const }));

  const suggestions: HashtagSuggestion[] = [];
  const prefix = rules.hashtagPrefix;

  // 1. Topic-based hashtags from provided tags
  for (const tag of tags.slice(0, 3)) {
    suggestions.push({ tag: `${prefix}${tag}`, type: "topic" });
  }

  // 2. Topic-derived hashtag
  if (topic.length <= 10) {
    suggestions.push({ tag: `${prefix}${topic}`, type: "topic" });
  }

  // 3. Platform trending patterns
  const patterns = rules.hotHashtagPatterns;
  // Pick 2-3 relevant patterns
  const relevant = patterns.filter((p) =>
    topic.includes(p.slice(0, 2)) || tags.some((t) => t.includes(p.slice(0, 2))),
  );
  const selected = relevant.length > 0 ? relevant.slice(0, 2) : patterns.slice(0, 2);
  for (const p of selected) {
    suggestions.push({ tag: `${prefix}${p}`, type: "trending" });
  }

  // 4. Niche hashtag (combine keyword + platform pattern)
  if (tags[0] && patterns[0]) {
    suggestions.push({ tag: `${prefix}${tags[0]}${patterns[0]}`, type: "niche" });
  }

  // Deduplicate and limit
  const seen = new Set<string>();
  return suggestions
    .filter((s) => {
      if (seen.has(s.tag)) return false;
      seen.add(s.tag);
      return true;
    })
    .slice(0, rules.maxHashtags);
}

/**
 * Generate titles + hashtags for a specific platform in one call.
 */
export function generateForPlatform(
  baseTopic: string,
  platform: string,
  opts?: { keyword?: string; tags?: string[] },
): PlatformTitleResult {
  const rules = PLATFORM_RULES[platform];
  const titles = generateTitleVariants(baseTopic, platform, opts);
  const hashtags = generateHashtags(baseTopic, platform, opts?.tags);
  const tips = rules?.titleTips || [];

  return { platform, titles, hashtags, tips };
}

/**
 * Generate titles + hashtags for multiple platforms at once.
 */
export function generateForAllPlatforms(
  baseTopic: string,
  platforms: string[],
  opts?: { keyword?: string; tags?: string[] },
): PlatformTitleResult[] {
  return platforms.map((p) => generateForPlatform(baseTopic, p, opts));
}

// --- Title Builders ---

function buildHookTitle(topic: string, maxLen: number): string | null {
  const hooks = [
    `别再${topic.slice(0, 4)}了，试试这个`,
    `${topic.slice(0, 6)}的真相，没人告诉你`,
    `后悔没早知道的${topic.slice(0, 6)}`,
  ];
  const valid = hooks.filter((h) => h.length <= maxLen);
  return valid[0] || null;
}

function buildListTitle(topic: string, keyword: string, maxLen: number): string {
  const core = keyword || topic.slice(0, 6);
  const candidates = [
    `${core}必知的5个要点`,
    `3个${core}技巧，亲测有效`,
    `${core}避坑指南：7条经验`,
  ];
  return candidates.find((c) => c.length <= maxLen) || candidates[0].slice(0, maxLen);
}

function buildQuestionTitle(topic: string, maxLen: number): string {
  const candidates = [
    `${topic.slice(0, 8)}，你真的会吗？`,
    `为什么${topic.slice(0, 6)}总是做不好？`,
    `${topic.slice(0, 8)}到底怎么选？`,
  ];
  return candidates.find((c) => c.length <= maxLen) || candidates[0].slice(0, maxLen);
}

function buildStoryTitle(topic: string, maxLen: number): string {
  const candidates = [
    `我用${topic.slice(0, 6)}的真实经历`,
    `做了3个月${topic.slice(0, 4)}，说说感受`,
    `从零开始${topic.slice(0, 6)}，踩过的坑`,
  ];
  return candidates.find((c) => c.length <= maxLen) || candidates[0].slice(0, maxLen);
}
