/**
 * 今日工作台数据聚合（S3.0 主进程编排）。
 * 组合 profile 行业 + 雷达缓存候选（不联网）+ 内容流水线分组 + 最近已发布作品 vs 飞轮基线，
 * 一次返回供首屏单调用渲染。每个数据源各自 try/catch 降级——任一失败不拖垮整屏。
 * deps 为测试注入口（镜像 chat-persist）。
 */
import { loadProfile } from "../modules/profile/creator-profile.js";
import { getCachedTopicCandidates, type RadarItem } from "../modules/radar/topic-radar.js";
import { listContents, type Content, type ContentStatus } from "../storage/local-store.js";
import { buildBaseline } from "../modules/analytics/quality-baseline.js";

const STALE_DAYS = 2;
const RADAR_LIMIT = 10;

const BUCKET: Record<string, ContentStatus[]> = {
  draft: ["topic_saved", "drafting", "draft_ready", "revision"],
  review: ["reviewing", "cover_pending"],
  ready: ["approved", "publish_ready", "publishing"],
  published: ["published"],
};

export interface TodaySummary {
  industry: string;
  radar: { topics: RadarItem[]; fetchedAt: string | null };
  pipeline: {
    draft: number; review: number; ready: number; published: number;
    stale: { id: string; title: string; days: number } | null;
  };
  lastOutcome: {
    contentId: string; title: string; platform: string | null;
    completionRate: number | null; baselineCompletionRate: number | null; views: number | null;
  } | null;
}

export interface TodaySummaryDeps {
  loadProfile: (dataDir?: string) => Promise<{ industry: string } | null>;
  cachedTopics: (industry: string, dataDir?: string) => Promise<RadarItem[]>;
  listContents: (dataDir?: string) => Promise<Content[]>;
  buildBaseline: (dataDir?: string) => Promise<{ avgMetrics: Record<string, number> }>;
  now: () => number;
}

const defaults: TodaySummaryDeps = {
  loadProfile,
  cachedTopics: (industry, dataDir) => getCachedTopicCandidates(industry, dataDir, RADAR_LIMIT),
  listContents,
  buildBaseline,
  now: () => Date.now(),
};

type PipelineBucket = "draft" | "review" | "ready" | "published";

function bucketOf(status: string): PipelineBucket | null {
  for (const [b, list] of Object.entries(BUCKET)) {
    if ((list as string[]).includes(status)) return b as PipelineBucket;
  }
  return null;
}

export async function buildTodaySummary(
  dataDir?: string,
  deps: TodaySummaryDeps = defaults,
): Promise<TodaySummary> {
  let industry = "知识口播";
  try {
    const p = await deps.loadProfile(dataDir);
    if (p?.industry) industry = p.industry;
  } catch { /* 默认赛道 */ }

  const radar: TodaySummary["radar"] = { topics: [], fetchedAt: null };
  try {
    radar.topics = await deps.cachedTopics(industry, dataDir);
  } catch { /* 雷达失败 → 空，UI 引导刷新 */ }

  const pipeline: TodaySummary["pipeline"] = { draft: 0, review: 0, ready: 0, published: 0, stale: null };
  let lastOutcome: TodaySummary["lastOutcome"] = null;
  let contents: Content[] = [];
  try {
    contents = await deps.listContents(dataDir);
  } catch { contents = []; }

  let staleBest: { id: string; title: string; days: number } | null = null;
  const published: Content[] = [];
  for (const c of contents) {
    const b = bucketOf(c.status);
    if (b) pipeline[b] += 1;
    if (b === "draft") {
      const days = Math.floor((deps.now() - new Date(c.updatedAt).getTime()) / 86_400_000);
      if (days >= STALE_DAYS && (!staleBest || days > staleBest.days)) {
        staleBest = { id: c.id, title: c.title, days };
      }
    }
    if (c.status === "published") published.push(c);
  }
  pipeline.stale = staleBest;

  if (published.length > 0) {
    published.sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")));
    const latest = published[0];
    let baselineCompletionRate: number | null = null;
    try {
      const base = await deps.buildBaseline(dataDir);
      baselineCompletionRate = typeof base.avgMetrics.completionRate === "number" ? base.avgMetrics.completionRate : null;
    } catch { /* 基线失败 → null */ }
    const pd = latest.performanceData ?? {};
    lastOutcome = {
      contentId: latest.id,
      title: latest.title,
      platform: latest.platform ?? null,
      completionRate: typeof pd.completionRate === "number" ? pd.completionRate : null,
      baselineCompletionRate,
      views: typeof pd.views === "number" ? pd.views : null,
    };
  }

  return { industry, radar, pipeline, lastOutcome };
}
