/**
 * Free Research Engine — topic discovery using only public web search
 *
 * No crawlers, no third-party APIs. Pure web_search + style calibration + viral scoring.
 *
 * PRD §5: "Free 版选题（纯公开搜索）"
 */
import { loadProfile, type CreatorProfile } from "../profile/creator-profile.js";

// --- Types ---

export interface TopicCandidate {
  title: string;
  description: string;
  tags: string[];
  source: string;
  /** 0-100 viral potential score */
  viralScore: number;
  /** Score breakdown */
  scoreBreakdown: {
    titleAppeal: number;
    topicHeat: number;
    profileFit: number;
  };
  /** Why this topic was suggested */
  reasoning: string;
}

export interface FreeResearchResult {
  ok: boolean;
  keyword: string;
  industry: string;
  candidates: TopicCandidate[];
  /** Search queries that were used */
  searchQueries: string[];
  /** Style filters applied */
  filtersApplied: string[];
  summary: string;
}

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

/**
 * Build search queries for topic discovery.
 * Returns 3-5 queries tailored to the user's industry and keyword.
 */
export function buildSearchQueries(
  keyword: string,
  industry: string,
  platforms: string[],
): string[] {
  const queries: string[] = [];
  const currentMonth = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" });

  // Core queries
  queries.push(`${industry} ${keyword} 内容选题`);
  queries.push(`${industry} 热门话题 ${currentMonth}`);
  queries.push(`${keyword} 爆款内容 分析`);

  // Platform-specific
  const platformNames: Record<string, string> = {
    xhs: "小红书",
    xiaohongshu: "小红书",
    douyin: "抖音",
    wechat_mp: "公众号",
    bilibili: "B站",
  };
  const primaryPlatform = platforms[0];
  if (primaryPlatform && platformNames[primaryPlatform]) {
    queries.push(`${keyword} ${platformNames[primaryPlatform]} 爆款`);
  }

  // Trend query
  queries.push(`${keyword} 最新趋势 ${new Date().getFullYear()}`);

  return queries;
}

/**
 * Score a topic candidate for viral potential.
 *
 * Dimensions (each 0-33, total normalized to 0-100):
 * - Title appeal: length, specificity, emotional triggers, numbers
 * - Topic heat: keyword relevance, timeliness signals
 * - Profile fit: alignment with user's industry, audience, writing rules
 */
export function scoreCandidate(
  candidate: { title: string; description: string; tags: string[] },
  profile: CreatorProfile | null,
  keyword: string,
): { viralScore: number; breakdown: TopicCandidate["scoreBreakdown"]; reasoning: string } {
  let titleAppeal = 15;
  let topicHeat = 15;
  let profileFit = 15;
  const reasons: string[] = [];

  // --- Title Appeal ---
  const titleLen = candidate.title.length;
  // Optimal title length: 10-20 chars
  if (titleLen >= 10 && titleLen <= 20) {
    titleAppeal += 5;
  } else if (titleLen > 25) {
    titleAppeal -= 3;
  }
  // Numbers in title
  if (/\d/.test(candidate.title)) {
    titleAppeal += 5;
    reasons.push("标题含数字，吸引力+");
  }
  // Emotional triggers
  if (/别再|千万|后悔|真相|没想到|居然|竟然|绝了|必看|干货|避坑/.test(candidate.title)) {
    titleAppeal += 5;
    reasons.push("标题有情绪触发词");
  }
  // Specificity (not generic)
  if (/推荐|分享|介绍|总结/.test(candidate.title) && !/\d/.test(candidate.title)) {
    titleAppeal -= 5;
    reasons.push("标题偏泛，建议加具体角度");
  }
  // Question format
  if (/[？?]/.test(candidate.title)) {
    titleAppeal += 3;
  }
  titleAppeal = clamp(titleAppeal, 0, 33);

  // --- Topic Heat ---
  // Keyword match
  if (candidate.title.includes(keyword) || candidate.description.includes(keyword)) {
    topicHeat += 5;
  }
  // Timeliness signals
  const year = String(new Date().getFullYear());
  if (candidate.description.includes(year) || candidate.description.includes("最新")) {
    topicHeat += 5;
    reasons.push("话题有时效性");
  }
  // Tags relevance
  if (candidate.tags.length >= 3) {
    topicHeat += 3;
  }
  // Description quality (has data/evidence)
  if (/\d+[%％万亿]/.test(candidate.description)) {
    topicHeat += 5;
    reasons.push("描述引用了数据");
  }
  topicHeat = clamp(topicHeat, 0, 33);

  // --- Profile Fit ---
  if (profile) {
    // Industry match
    if (profile.industry && (candidate.title.includes(profile.industry) || candidate.tags.some((t) => t.includes(profile.industry)))) {
      profileFit += 5;
      reasons.push("与用户行业匹配");
    }
    // Audience match
    if (profile.audiencePersona) {
      const painPoints = profile.audiencePersona.painPoints || [];
      for (const pain of painPoints) {
        if (candidate.title.includes(pain) || candidate.description.includes(pain)) {
          profileFit += 5;
          reasons.push(`命中受众痛点: ${pain}`);
          break;
        }
      }
    }
    // Style boundary check (never list)
    const neverTopics = profile.styleBoundaries?.never || [];
    for (const never of neverTopics) {
      if (candidate.title.includes(never) || candidate.description.includes(never)) {
        profileFit -= 10;
        reasons.push(`触碰风格禁区: ${never}`);
        break;
      }
    }
  }
  profileFit = clamp(profileFit, 0, 34);

  const viralScore = clamp(titleAppeal + topicHeat + profileFit, 0, 100);
  const reasoning = reasons.length > 0 ? reasons.join("；") : "综合评估";

  return {
    viralScore,
    breakdown: { titleAppeal, topicHeat, profileFit },
    reasoning,
  };
}

/**
 * Filter candidates against the user's style profile.
 * Removes topics that conflict with writing rules or style boundaries.
 */
export function filterByStyle(
  candidates: TopicCandidate[],
  profile: CreatorProfile | null,
): { filtered: TopicCandidate[]; filtersApplied: string[] } {
  if (!profile) return { filtered: candidates, filtersApplied: [] };

  const filtersApplied: string[] = [];
  let filtered = [...candidates];

  // Filter by style boundaries (never list)
  const neverTopics = profile.styleBoundaries?.never || [];
  if (neverTopics.length > 0) {
    const before = filtered.length;
    filtered = filtered.filter((c) => {
      return !neverTopics.some(
        (n) => c.title.includes(n) || c.description.includes(n),
      );
    });
    if (filtered.length < before) {
      filtersApplied.push(`排除了 ${before - filtered.length} 个触碰风格禁区的选题`);
    }
  }

  // Filter low profile-fit scores
  const lowFitBefore = filtered.length;
  filtered = filtered.filter((c) => c.scoreBreakdown.profileFit >= 5);
  if (filtered.length < lowFitBefore) {
    filtersApplied.push(`排除了 ${lowFitBefore - filtered.length} 个与用户定位不匹配的选题`);
  }

  return { filtered, filtersApplied };
}

/**
 * Process raw search results into scored topic candidates.
 *
 * This is the core function that the research skill/tool calls after
 * performing web searches. It takes raw search results and produces
 * scored, filtered topic candidates.
 */
export async function processSearchResults(
  searchResults: SearchResult[],
  keyword: string,
  profile: CreatorProfile | null,
  topicCount: number = 5,
): Promise<{ candidates: TopicCandidate[]; filtersApplied: string[] }> {
  // Deduplicate by title similarity
  const seen = new Set<string>();
  const unique = searchResults.filter((r) => {
    const key = r.title.slice(0, 15);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Convert to candidates and score
  let candidates: TopicCandidate[] = unique.map((r) => {
    // Extract a concise title (≤20 chars)
    let title = r.title.replace(/[-_|—–].*$/, "").trim();
    if (title.length > 20) title = title.slice(0, 20);

    // Extract tags from snippet
    const tags = extractTags(r.snippet, keyword);

    const { viralScore, breakdown, reasoning } = scoreCandidate(
      { title, description: r.snippet, tags },
      profile,
      keyword,
    );

    return {
      title,
      description: r.snippet.slice(0, 200),
      tags,
      source: `web_search: ${r.url}`,
      viralScore,
      scoreBreakdown: breakdown,
      reasoning,
    };
  });

  // Style filter
  const { filtered, filtersApplied } = filterByStyle(candidates, profile);
  candidates = filtered;

  // Sort by viral score descending
  candidates.sort((a, b) => b.viralScore - a.viralScore);

  // Return top N
  return {
    candidates: candidates.slice(0, topicCount),
    filtersApplied,
  };
}

/**
 * Main entry: run the free research engine.
 *
 * Note: This function does NOT perform web searches itself — it expects
 * the caller (skill or tool) to provide search results. This keeps the
 * module pure and testable.
 */
export async function runFreeResearch(opts: {
  keyword: string;
  searchResults: SearchResult[];
  topicCount?: number;
  dataDir?: string;
}): Promise<FreeResearchResult> {
  const { keyword, searchResults, topicCount = 5, dataDir } = opts;
  const profile = await loadProfile(dataDir);
  const industry = profile?.industry || "通用";

  const queries = buildSearchQueries(keyword, industry, profile?.platforms || []);
  const { candidates, filtersApplied } = await processSearchResults(
    searchResults,
    keyword,
    profile,
    topicCount,
  );

  const summary =
    candidates.length > 0
      ? `找到 ${candidates.length} 个选题候选（最高分 ${candidates[0].viralScore}）`
      : "未找到合适的选题候选，建议换个关键词或方向";

  return {
    ok: true,
    keyword,
    industry,
    candidates,
    searchQueries: queries,
    filtersApplied,
    summary,
  };
}

// --- Helpers ---

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function extractTags(text: string, keyword: string): string[] {
  const tags = new Set<string>();
  tags.add(keyword);

  // Extract hashtag-like patterns
  const hashMatches = text.match(/#[\u4e00-\u9fffA-Za-z0-9]+/g);
  if (hashMatches) {
    for (const m of hashMatches.slice(0, 4)) {
      tags.add(m.replace("#", ""));
    }
  }

  // Extract quoted terms
  const quoteMatches = text.match(/[「」""]/g) ? text.match(/[「「]([^」」]+)[」」]/g) : null;
  if (quoteMatches) {
    for (const m of quoteMatches.slice(0, 2)) {
      const clean = m.replace(/[「」""]/g, "");
      if (clean.length <= 8) tags.add(clean);
    }
  }

  return Array.from(tags).slice(0, 5);
}
