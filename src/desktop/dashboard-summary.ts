/**
 * Dashboard 经营层数据聚合（IA v4.2 §2 第一批组件，单次调用全返回）。
 * 组件对齐契约：待审队列（排序：过期告警 > 发布窗口临近 > 新完成）、回填待办
 * （纯读模型：published 且未回填，T+1 提醒 / T+3 告警）、校准状态、管线摘要、
 * 灵感摘要（今日 top-3 可写 + 入库理由）。每个数据源独立降级——任一失败不拖垮整屏。
 * 红线：一切数字来自真实 store，无引擎事件不造活性（PRD-v4 §7.4）。
 */
import { loadProfile } from "../modules/profile/creator-profile.js";
import { listContents, listTopics, normalizeLegacyStatus, type Content } from "../storage/local-store.js";

const REVIEW_STATUSES = new Set(["reviewing", "cover_pending"]);
const WRITING_STATUSES = new Set(["topic_saved", "drafting", "draft_ready", "revision"]);
const READY_STATUSES = new Set(["approved", "publish_ready", "publishing"]);
const OVERDUE_REVIEW_DAYS = 3;
const PLATFORM_WINDOW_DAYS = 3;
const BACKFILL_DUE_DAYS = 1;
const BACKFILL_OVERDUE_DAYS = 3;
const INSPIRATION_LIMIT = 3;
const RECENT_RULES_LIMIT = 3;

export type ReviewPriority = "overdue" | "window" | "fresh";

export interface DashboardSummary {
  calibration: {
    styleCalibrated: boolean;
    industry: string;
    activeRuleCount: number;
    voiceCoreCount: number;
    recentRules: Array<{ rule: string; createdAt: string }>;
  };
  reviewQueue: Array<{
    id: string; title: string; platform: string | null;
    status: string; ageDays: number; priority: ReviewPriority;
  }>;
  backfillTodos: Array<{
    id: string; title: string; platform: string | null;
    publishedAt: string; daysSince: number; level: "due" | "overdue";
  }>;
  pipeline: { idea: number; writing: number; review: number; ready: number; published: number };
  inspirations: Array<{ id: string; title: string; reason: string | null; source: string | null; link: string | null }>;
  /** 首跑判据：无档案，或（未校准 且 无任何内容/灵感）→ 空态即 onboarding（§3） */
  isFirstRun: boolean;
}

function daysBetween(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
}

export async function buildDashboardSummary(dataDir?: string, now = Date.now()): Promise<DashboardSummary> {
  let profile: Awaited<ReturnType<typeof loadProfile>> = null;
  try { profile = await loadProfile(dataDir); } catch { /* 降级 */ }

  let contents: Content[] = [];
  try { contents = await listContents(dataDir); } catch { /* 降级 */ }

  let topics: Awaited<ReturnType<typeof listTopics>> = [];
  try { topics = await listTopics(dataDir); } catch { /* 降级 */ }

  // ── 校准状态卡 ──
  const rules = profile?.writingRules ?? [];
  const activeRules = rules.filter((r) => !r.disabled);
  const calibration: DashboardSummary["calibration"] = {
    styleCalibrated: profile?.styleCalibrated ?? false,
    industry: profile?.industry ?? "",
    activeRuleCount: activeRules.length,
    voiceCoreCount: activeRules.filter((r) => (r.scope ?? "voice_core") === "voice_core").length,
    // 老 workspace 的规则可能缺 createdAt（schema 演进前的数据）——缺失当最旧排,不炸
    recentRules: [...activeRules]
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, RECENT_RULES_LIMIT)
      .map((r) => ({ rule: r.rule, createdAt: r.createdAt ?? "" })),
  };

  // ── 管线摘要 + 分组 ──
  const normalized = contents.map((c) => ({ ...c, status: normalizeLegacyStatus(c.status) }));
  const pipeline = { idea: topics.length, writing: 0, review: 0, ready: 0, published: 0 };
  const reviewItems: Content[] = [];
  const publishedItems: Content[] = [];
  for (const c of normalized) {
    if (WRITING_STATUSES.has(c.status)) pipeline.writing++;
    else if (REVIEW_STATUSES.has(c.status)) { pipeline.review++; reviewItems.push(c); }
    else if (READY_STATUSES.has(c.status)) pipeline.ready++;
    else if (c.status === "published") { pipeline.published++; publishedItems.push(c); }
  }

  // ── 待审队列（排序：过期告警 > 发布窗口临近 > 新完成；同级新→旧） ──
  // 「发布窗口临近」朴素口径：该平台距上次发布 > PLATFORM_WINDOW_DAYS 天 = 该发了
  const lastPublishedByPlatform = new Map<string, number>();
  for (const c of publishedItems) {
    if (!c.platform || !c.publishedAt) continue;
    const ts = new Date(c.publishedAt).getTime();
    if (ts > (lastPublishedByPlatform.get(c.platform) ?? 0)) lastPublishedByPlatform.set(c.platform, ts);
  }
  const PRIORITY_RANK: Record<ReviewPriority, number> = { overdue: 0, window: 1, fresh: 2 };
  const reviewQueue = reviewItems
    .map((c) => {
      const ageDays = daysBetween(c.updatedAt, now);
      let priority: ReviewPriority = "fresh";
      if (ageDays >= OVERDUE_REVIEW_DAYS) priority = "overdue";
      else if (c.platform) {
        const last = lastPublishedByPlatform.get(c.platform);
        const gapDays = last === undefined ? Infinity : (now - last) / 86_400_000;
        if (gapDays > PLATFORM_WINDOW_DAYS) priority = "window";
      }
      return { id: c.id, title: c.title, platform: c.platform ?? null, status: c.status, ageDays, priority };
    })
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.ageDays - b.ageDays);

  // ── 回填待办（纯读模型：published 且 performanceData 空） ──
  const backfillTodos = publishedItems
    .filter((c) => c.publishedAt && Object.keys(c.performanceData ?? {}).length === 0)
    .map((c) => {
      const daysSince = daysBetween(c.publishedAt!, now);
      return {
        id: c.id, title: c.title, platform: c.platform ?? null,
        publishedAt: c.publishedAt!, daysSince,
        level: (daysSince >= BACKFILL_OVERDUE_DAYS ? "overdue" : "due") as "due" | "overdue",
      };
    })
    .filter((t) => t.daysSince >= BACKFILL_DUE_DAYS)
    .sort((a, b) => b.daysSince - a.daysSince);

  // ── 灵感摘要（今日 top-3 可写：最新入库优先，带入库理由） ──
  const inspirations = topics.slice(0, INSPIRATION_LIMIT).map((t) => ({
    id: t.id, title: t.title, reason: t.reason ?? null, source: t.source ?? null, link: t.link ?? null,
  }));

  const isFirstRun = !profile || (!profile.styleCalibrated && contents.length === 0 && topics.length === 0);

  return { calibration, reviewQueue, backfillTodos, pipeline, inspirations, isFirstRun };
}
