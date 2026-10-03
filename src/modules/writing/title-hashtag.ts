/**
 * 平台规则（标题字数、话题标签）与话题标签建议。
 *
 * 标题不再由代码拼：宿主按发布标题方法库（title-methods.ts）写，这里只留字数与标签规则。
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
  /** Common high-performing hashtag patterns */
  hotHashtagPatterns: string[];
}

export interface HashtagSuggestion {
  tag: string;
  /** "topic" = content-related, "trending" = platform trend, "niche" = audience-specific */
  type: "topic" | "trending" | "niche";
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
