/**
 * Quality Baseline — data-driven content quality assessment.
 *
 * Analyzes historical content performance to:
 * 1. Build a "what works" baseline from user's best-performing content
 * 2. Compare new content against the baseline
 * 3. Provide data-backed writing suggestions
 */
import { listContents, type Content } from "../../storage/local-store.js";
import { loadProfile, addPerformanceEntry, type PerformanceEntry } from "../profile/creator-profile.js";

export interface QualityBaseline {
  /** Number of data points used to build baseline */
  sampleSize: number;
  /** Average performance metrics */
  avgMetrics: Record<string, number>;
  /** Characteristics of top-performing content */
  topContentTraits: ContentTraits;
  /** Characteristics of low-performing content */
  lowContentTraits: ContentTraits;
  /** Actionable insights */
  insights: string[];
}

export interface ContentTraits {
  avgLength: number;
  avgParagraphs: number;
  avgEmojiCount: number;
  commonHookTypes: string[];
  commonPlatforms: string[];
  hasCTA: number; // percentage
}

export interface BaselineComparison {
  /** Overall match score 0-100 */
  matchScore: number;
  /** Specific comparisons */
  comparisons: Array<{
    dimension: string;
    current: number | string;
    baseline: number | string;
    status: "good" | "warning" | "poor";
    suggestion?: string;
  }>;
  /** Summary message */
  summary: string;
}

export interface PerformanceTrackingResult {
  ok: boolean;
  contentId: string;
  metrics: Record<string, number>;
  /** How this content compares to baseline */
  comparison?: string;
}

// --- Helpers ---

function analyzeTraits(contents: Content[]): ContentTraits {
  if (contents.length === 0) {
    return {
      avgLength: 0,
      avgParagraphs: 0,
      avgEmojiCount: 0,
      commonHookTypes: [],
      commonPlatforms: [],
      hasCTA: 0,
    };
  }

  let totalLength = 0;
  let totalParagraphs = 0;
  let totalEmoji = 0;
  let ctaCount = 0;
  const platforms = new Map<string, number>();

  for (const c of contents) {
    const body = c.body || "";
    totalLength += body.length;
    totalParagraphs += body.split(/\n{2,}/).filter(p => p.trim()).length;
    totalEmoji += (body.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;

    if (/关注|收藏|点赞|转发|评论|私信|留言/.test(body.slice(-200))) {
      ctaCount++;
    }

    const p = c.platform || "unspecified";
    platforms.set(p, (platforms.get(p) || 0) + 1);
  }

  const n = contents.length;
  const sortedPlatforms = Array.from(platforms.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p);

  return {
    avgLength: Math.round(totalLength / n),
    avgParagraphs: Math.round(totalParagraphs / n),
    avgEmojiCount: Math.round(totalEmoji / n),
    commonHookTypes: [], // Would need NLP to detect, placeholder
    commonPlatforms: sortedPlatforms.slice(0, 3),
    hasCTA: Math.round((ctaCount / n) * 100),
  };
}

function getPerformanceScore(entry: PerformanceEntry): number {
  const m = entry.metrics;
  // Weighted score: likes * 2 + comments * 3 + shares * 5 + saves * 4 + views * 0.01
  return (
    (m.likes || 0) * 2 +
    (m.comments || 0) * 3 +
    (m.shares || 0) * 5 +
    (m.saves || 0) * 4 +
    (m.views || 0) * 0.01
  );
}

// --- Main Functions ---

/**
 * Build a quality baseline from historical performance data.
 */
export async function buildBaseline(dataDir?: string): Promise<QualityBaseline> {
  const [contents, profile] = await Promise.all([
    listContents(dataDir),
    loadProfile(dataDir),
  ]);

  const performanceHistory = profile?.performanceHistory || [];

  if (performanceHistory.length < 3) {
    return {
      sampleSize: performanceHistory.length,
      avgMetrics: {},
      topContentTraits: analyzeTraits([]),
      lowContentTraits: analyzeTraits([]),
      insights: [
        `目前只有 ${performanceHistory.length} 条数据，需要至少 3 条才能建立基线。`,
        "发布内容后，用 autocrew_content action=update performance_data={...} 回填数据。",
      ],
    };
  }

  // Calculate average metrics
  const avgMetrics: Record<string, number> = {};
  const metricKeys = new Set<string>();
  for (const entry of performanceHistory) {
    for (const key of Object.keys(entry.metrics)) {
      metricKeys.add(key);
    }
  }
  for (const key of metricKeys) {
    const values = performanceHistory.map(e => e.metrics[key] || 0);
    avgMetrics[key] = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }

  // Split into top and bottom performers
  const scored = performanceHistory
    .map(e => ({ entry: e, score: getPerformanceScore(e) }))
    .sort((a, b) => b.score - a.score);

  const topCount = Math.max(1, Math.floor(scored.length * 0.3));
  const topIds = new Set(scored.slice(0, topCount).map(s => s.entry.contentId));
  const bottomIds = new Set(scored.slice(-topCount).map(s => s.entry.contentId));

  const topContents = contents.filter(c => topIds.has(c.id));
  const bottomContents = contents.filter(c => bottomIds.has(c.id));

  const topTraits = analyzeTraits(topContents);
  const bottomTraits = analyzeTraits(bottomContents);

  // Generate insights
  const insights: string[] = [];

  if (topTraits.avgLength > bottomTraits.avgLength * 1.3) {
    insights.push(`你表现好的内容平均 ${topTraits.avgLength} 字，比表现差的长 ${Math.round(((topTraits.avgLength / Math.max(bottomTraits.avgLength, 1)) - 1) * 100)}%。长内容可能更适合你。`);
  } else if (bottomTraits.avgLength > topTraits.avgLength * 1.3) {
    insights.push(`你表现好的内容平均 ${topTraits.avgLength} 字，比表现差的短。精简内容可能效果更好。`);
  }

  if (topTraits.hasCTA > bottomTraits.hasCTA + 20) {
    insights.push(`表现好的内容 ${topTraits.hasCTA}% 有明确 CTA，表现差的只有 ${bottomTraits.hasCTA}%。记得加 CTA。`);
  }

  if (topTraits.avgEmojiCount > bottomTraits.avgEmojiCount + 2) {
    insights.push(`表现好的内容平均用 ${topTraits.avgEmojiCount} 个 emoji，适当使用 emoji 有帮助。`);
  }

  if (insights.length === 0) {
    insights.push("数据还不够多，暂时没有明显的模式差异。继续积累数据。");
  }

  return {
    sampleSize: performanceHistory.length,
    avgMetrics,
    topContentTraits: topTraits,
    lowContentTraits: bottomTraits,
    insights,
  };
}

/**
 * Compare a piece of content against the quality baseline.
 */
export async function compareToBaseline(
  contentId: string,
  dataDir?: string,
): Promise<BaselineComparison> {
  const contents = await listContents(dataDir);
  const content = contents.find(c => c.id === contentId);

  if (!content) {
    return {
      matchScore: 0,
      comparisons: [],
      summary: `内容 ${contentId} 不存在`,
    };
  }

  const baseline = await buildBaseline(dataDir);

  if (baseline.sampleSize < 3) {
    return {
      matchScore: 50,
      comparisons: [],
      summary: "数据不足，无法对比。发布更多内容并回填数据后再试。",
    };
  }

  const comparisons: BaselineComparison["comparisons"] = [];
  const body = content.body || "";
  const topTraits = baseline.topContentTraits;

  // Length comparison
  const lengthDiff = Math.abs(body.length - topTraits.avgLength) / Math.max(topTraits.avgLength, 1);
  comparisons.push({
    dimension: "内容长度",
    current: `${body.length} 字`,
    baseline: `${topTraits.avgLength} 字（爆款平均）`,
    status: lengthDiff < 0.2 ? "good" : lengthDiff < 0.5 ? "warning" : "poor",
    suggestion: lengthDiff >= 0.3
      ? body.length < topTraits.avgLength
        ? "内容偏短，建议补充更多细节"
        : "内容偏长，建议精简"
      : undefined,
  });

  // Paragraph count
  const paragraphs = body.split(/\n{2,}/).filter(p => p.trim()).length;
  comparisons.push({
    dimension: "段落数",
    current: `${paragraphs}`,
    baseline: `${topTraits.avgParagraphs}（爆款平均）`,
    status: Math.abs(paragraphs - topTraits.avgParagraphs) <= 2 ? "good" : "warning",
  });

  // CTA check
  const hasCTA = /关注|收藏|点赞|转发|评论|私信|留言/.test(body.slice(-200));
  comparisons.push({
    dimension: "CTA",
    current: hasCTA ? "有" : "无",
    baseline: `${topTraits.hasCTA}% 的爆款有 CTA`,
    status: hasCTA ? "good" : topTraits.hasCTA > 60 ? "poor" : "warning",
    suggestion: !hasCTA && topTraits.hasCTA > 60 ? "建议在结尾加引导互动的句子" : undefined,
  });

  // Calculate match score
  const scores = comparisons.map(c =>
    c.status === "good" ? 100 : c.status === "warning" ? 60 : 30
  );
  const matchScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  const summary = matchScore >= 80
    ? `✅ 与你的爆款特征匹配度 ${matchScore}%，质量不错`
    : matchScore >= 60
      ? `⚠️ 匹配度 ${matchScore}%，有优化空间`
      : `❌ 匹配度 ${matchScore}%，建议参考你过去的爆款特征调整`;

  return { matchScore, comparisons, summary };
}

/**
 * Track performance data for a published content.
 */
export async function trackPerformance(
  contentId: string,
  metrics: Record<string, number>,
  dataDir?: string,
): Promise<PerformanceTrackingResult> {
  const contents = await listContents(dataDir);
  const content = contents.find(c => c.id === contentId);

  if (!content) {
    return { ok: false, contentId, metrics };
  }

  // Save to profile
  await addPerformanceEntry(
    { contentId, platform: content.platform || "unknown", metrics },
    dataDir,
  );

  // Quick comparison
  const baseline = await buildBaseline(dataDir);
  let comparison: string | undefined;

  if (baseline.sampleSize >= 3) {
    const avgViews = baseline.avgMetrics.views || 0;
    const currentViews = metrics.views || 0;
    if (currentViews > avgViews * 1.5) {
      comparison = `🔥 这篇表现超过你的平均水平 ${Math.round(((currentViews / Math.max(avgViews, 1)) - 1) * 100)}%！`;
    } else if (currentViews < avgViews * 0.5) {
      comparison = `这篇表现低于平均水平，可以分析一下原因。`;
    } else {
      comparison = `表现正常，接近你的平均水平。`;
    }
  }

  return { ok: true, contentId, metrics, comparison };
}
