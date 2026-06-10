/**
 * Quality Baseline — data-driven content quality assessment.
 *
 * Analyzes historical content performance to:
 * 1. Build a "what works" baseline from user's best-performing content
 * 2. Compare new content against the baseline
 * 3. Provide data-backed writing suggestions
 */
import { listContents, type Content } from "../../storage/local-store.js";
import { loadProfile, type PerformanceEntry } from "../profile/creator-profile.js";
import { listOutcomes, recordOutcome } from "../flywheel/outcome-store.js";
import { outcomeKey } from "../flywheel/outcome-schema.js";

export interface QualityBaseline {
  /** Number of data points used to build baseline */
  sampleSize: number;
  /** matched 条目数（能对应到 AutoCrew 稿件、用于 trait 切分的子集） */
  traitSampleSize: number;
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
  /** Why tracking failed (content not found / outcome store rejection) */
  error?: string;
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
  // Weighted score: likes * 2 + comments * 3 + shares * 5 + saves/favorites * 4 + views * 0.01
  // favorites = CSV 导入的收藏字段；saves 保留兼容 paste 路径。
  // completionRate（口播主 reward signal）的计权推迟到赛道包计划（KOUBO_REWARD 接线时一并做）。
  return (
    (m.likes || 0) * 2 +
    (m.comments || 0) * 3 +
    (m.shares || 0) * 5 +
    (m.saves || 0) * 4 +
    (m.favorites || 0) * 4 +
    (m.views || 0) * 0.01
  );
}

/** 本地日期 YYYY-MM-DD（非 UTC：Asia/Shanghai 早 8 点前 toISOString 会记成昨天） */
function localDateStamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Outcome store 是唯一真实来源；为空时 fallback 到 legacy profile.performanceHistory。
 * 多个 metricDate 快照只取每个作品最新一份，避免重复计权。
 */
async function loadPerformanceHistory(dataDir?: string): Promise<PerformanceEntry[]> {
  const outcomes = await listOutcomes(dataDir);
  const latestByItem = new Map<string, (typeof outcomes)[number]>();
  for (const o of outcomes) {
    const itemKey = outcomeKey({ ...o, metricDate: "" });
    const prev = latestByItem.get(itemKey);
    if (!prev || o.metricDate > prev.metricDate) latestByItem.set(itemKey, o);
  }
  const fromOutcomes: PerformanceEntry[] = Array.from(latestByItem.values()).map((o) => ({
    contentId: o.contentId ?? `hist:${o.platform}:${o.platformTitle}`,
    platform: o.platform,
    metrics: Object.fromEntries(
      Object.entries(o.metrics).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>,
    recordedAt: o.recordedAt,
  }));
  if (fromOutcomes.length > 0) return fromOutcomes;
  const profile = await loadProfile(dataDir);
  return profile?.performanceHistory || [];
}

function computeAvgMetrics(history: PerformanceEntry[]): Record<string, number> {
  const avgMetrics: Record<string, number> = {};
  const metricKeys = new Set<string>();
  for (const entry of history) {
    for (const key of Object.keys(entry.metrics)) {
      metricKeys.add(key);
    }
  }
  for (const key of metricKeys) {
    const values = history.map(e => e.metrics[key] || 0);
    avgMetrics[key] = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }
  return avgMetrics;
}

/**
 * top/bottom 30% 切分。只在 matched 条目（contentId 能解析到真实 content）上做：
 * 历史条目（hist: 伪 id）落在任一档位都会把该档位变成全零 traits，产出捏造的对比建议。
 * matched 不足 3 条时不切分（返回空 → 零值 traits → 跳过对比型 insight）。
 */
function splitTopBottom(
  matched: PerformanceEntry[],
  contents: Content[],
): { topContents: Content[]; bottomContents: Content[] } {
  if (matched.length < 3) return { topContents: [], bottomContents: [] };
  const scored = matched
    .map(e => ({ entry: e, score: getPerformanceScore(e) }))
    .sort((a, b) => b.score - a.score);
  const topCount = Math.max(1, Math.floor(scored.length * 0.3));
  const topIds = new Set(scored.slice(0, topCount).map(s => s.entry.contentId));
  const bottomIds = new Set(scored.slice(-topCount).map(s => s.entry.contentId));
  return {
    topContents: contents.filter(c => topIds.has(c.id)),
    bottomContents: contents.filter(c => bottomIds.has(c.id)),
  };
}

/** 对比型 insight 只在两个档位都有真实 content 时生成，避免拿真实 traits 对比零值 */
function generateInsights(
  topTraits: ContentTraits,
  bottomTraits: ContentTraits,
  hasBothBands: boolean,
): string[] {
  const insights: string[] = [];

  if (hasBothBands) {
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
  }

  if (insights.length === 0) {
    insights.push("数据还不够多，暂时没有明显的模式差异。继续积累数据。");
  }
  return insights;
}

// --- Main Functions ---

/**
 * Build a quality baseline from historical performance data.
 */
export async function buildBaseline(dataDir?: string): Promise<QualityBaseline> {
  const [contents, performanceHistory] = await Promise.all([
    listContents(dataDir),
    loadPerformanceHistory(dataDir),
  ]);

  // traits 切分只在 matched 条目上做（见 splitTopBottom 注释）
  const contentIds = new Set(contents.map((c) => c.id));
  const matched = performanceHistory.filter((e) => contentIds.has(e.contentId));

  if (performanceHistory.length < 3) {
    return {
      sampleSize: performanceHistory.length,
      traitSampleSize: matched.length,
      avgMetrics: {},
      topContentTraits: analyzeTraits([]),
      lowContentTraits: analyzeTraits([]),
      insights: [
        `目前只有 ${performanceHistory.length} 条数据，需要至少 3 条才能建立基线。`,
        "发布内容后，用 autocrew_content action=update performance_data={...} 回填数据。",
      ],
    };
  }

  // avgMetrics / sampleSize 在全量（含历史回灌）上计算 —— day-1 价值所在
  const avgMetrics = computeAvgMetrics(performanceHistory);

  const { topContents, bottomContents } = splitTopBottom(matched, contents);

  const topTraits = analyzeTraits(topContents);
  const bottomTraits = analyzeTraits(bottomContents);
  const insights = generateInsights(
    topTraits,
    bottomTraits,
    topContents.length > 0 && bottomContents.length > 0,
  );

  return {
    sampleSize: performanceHistory.length,
    traitSampleSize: matched.length,
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

  // traitSampleSize 也要 ≥3：纯历史回灌（day-1）sampleSize 过 3 但 trait 档位全空，
  // 拿零值 traits 对比会对每篇草稿捏造 "0 字（爆款平均）→ poor"
  if (baseline.sampleSize < 3 || baseline.traitSampleSize < 3) {
    return {
      matchScore: 50,
      comparisons: [],
      summary: `已有 ${baseline.sampleSize} 条表现数据，但能对应到 AutoCrew 稿件的不足 3 条。发布后用 confirm_published 打标，积累 3 条即可对比。`,
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
    return { ok: false, contentId, metrics, error: `内容 ${contentId} 不存在` };
  }

  // 单一写入路径：写穿 outcome store（profile.performanceHistory 降级为只读 legacy）
  const write = await recordOutcome(
    {
      contentId,
      platform: content.platform || "unknown",
      platformTitle: content.title,
      publishedAt: content.publishedAt,
      metricDate: localDateStamp(),
      metrics,
      source: "paste",
    },
    dataDir,
  );
  if (!write.ok) {
    return { ok: false, contentId, metrics, error: write.error };
  }

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
