/**
 * Dashboard 经营层数据聚合（IA v4.2 §2 第一批组件，单次调用全返回）。
 * 组件对齐契约：待审队列（排序：过期告警 > 发布窗口临近 > 新完成）、回填待办
 * （纯读模型：published 且 outcomes 里没有发布日之后的有效快照，T+1 提醒 / T+3 告警）、
 * 成片就绪待发布、校准状态、管线摘要、灵感摘要（今日 top-3 可写 + 入库理由）。
 * 每个数据源独立降级——任一失败不拖垮整屏；唯独 outcomes 读失败**不降级为空**，
 * 它决定「有没有待办」，静默当空会造假待办（发布闭环 spec §3.4）。
 * 红线：一切数字来自真实 store，无引擎事件不造活性（PRD-v4 §7.4）。
 */
import { loadProfile, personaSummary } from "../modules/profile/creator-profile.js";
import { listContents, listTopics, normalizeLegacyStatus, type Content } from "../storage/local-store.js";
import { listOutcomes } from "../modules/flywheel/outcome-store.js";
import type { PerformanceOutcome } from "../modules/flywheel/outcome-schema.js";
import {
  PULL_PLATFORMS,
  PULL_PLATFORM_CONSOLES,
  PULL_PLATFORM_LABELS,
  readPullState,
} from "../modules/flywheel/pull-state.js";

// 阶段制起（spec §0 清扫 2）：cover_pending 不再是「待审」——它是定稿之后的生产阶段，
// 和 editing 一起归在「待发布」这一列，跟 approved 同侧。
const REVIEW_STATUSES = new Set(["reviewing"]);
// needs_evidence（P1 §4.4）也算「在写」：稿子写出来了但被数字硬门拦着，还没成
const WRITING_STATUSES = new Set(["topic_saved", "drafting", "needs_evidence", "draft_ready", "revision"]);
const READY_STATUSES = new Set(["approved", "editing", "cover_pending", "publish_ready", "publishing"]);
/** 已经进了发布流程（或已退场）的状态：成片就绪待办到此为止，不再催 */
const PUBLISH_TRACK_STATUSES = new Set(["approved", "editing", "cover_pending", "publish_ready", "publishing", "published", "archived"]);
/** 「已回填」只认这三个核心指标——回流一条全空的快照不算回填过 */
const CORE_METRICS = ["views", "likes", "comments"] as const;
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
    /** 受众画像状态(V5.5 四问 IA「数据与成长」区):一行摘要 + 是否经用户校准 */
    persona: { summary: string; calibrated: boolean };
  };
  reviewQueue: Array<{
    id: string; title: string; platform: string | null;
    status: string; ageDays: number; priority: ReviewPriority;
  }>;
  backfillTodos: Array<{
    id: string; title: string; platform: string | null;
    publishedAt: string; daysSince: number; level: "due" | "overdue";
  }>;
  /**
   * 回流数据（outcomes.jsonl）读得出来没有（发布闭环 spec §3.4）。
   * false = 判不了谁回填过：`backfillTodos` 一律为空，界面要说「数据不可用」——
   * 读失败降级成空数组会把「读不出来」谎报成「一条都没回填」，制造满屏假待办。
   */
  outcomesAvailable: boolean;
  /**
   * 登录态过期待办（回流 spec §4.4）：已启用自动回流的平台里，上次抓取判定为 needs_login 的。
   * 扫码是唯一能让数据继续流的动作，所以它必须出现在工作台，而不是只躺在数据回流页。
   */
  pullLoginTodos: Array<{
    platform: string; label: string; consoleUrl: string;
    lastSuccessAt: string | null;
  }>;
  /**
   * 回流状态文件读得出来没有。false = 判不了登录态：`pullLoginTodos` 一律为空，
   * 界面说「状态不可用」——同 outcomesAvailable 的纪律，读失败不许造假待办。
   */
  pullStateAvailable: boolean;
  /** 成片就绪待发布（spec §3.3）：视频线盖了 videoReadyAt，但稿件还没进发布流程 */
  videoReadyTodos: Array<{
    id: string; title: string; platform: string | null;
    videoReadyAt: string; daysSince: number;
  }>;
  pipeline: { idea: number; writing: number; review: number; ready: number; published: number };
  inspirations: Array<{ id: string; title: string; reason: string | null; source: string | null; link: string | null }>;
  /** 首跑判据：无档案，或（未校准 且 无任何内容/灵感）→ 空态即 onboarding（§3） */
  isFirstRun: boolean;
}

function daysBetween(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
}

/** 本地时区的日期部分——metricDate 是 localDateStamp() 产的，比较必须同一把尺子 */
function localDatePart(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * contentId → 该稿的全部 outcome 快照。null = 读失败（不是「没有数据」）。
 * 一次读全量建索引：逐篇 getOutcomesForContent 会把 journal 读 N 遍（N 篇稿 = O(N²) 次行解析）。
 */
async function loadOutcomeIndex(dataDir?: string): Promise<Map<string, PerformanceOutcome[]> | null> {
  try {
    const index = new Map<string, PerformanceOutcome[]>();
    for (const o of await listOutcomes(dataDir)) {
      if (!o.contentId) continue; // 无主历史行不参与「这篇回填了没」
      const list = index.get(o.contentId);
      if (list) list.push(o);
      else index.set(o.contentId, [o]);
    }
    return index;
  } catch {
    return null;
  }
}

/** 已回填 = 发布日**之后**的快照里核心指标至少有一个有数（发布当天的零值快照不算，spec §3.4） */
function hasBackfilled(outcomes: PerformanceOutcome[] | undefined, publishedAt: string): boolean {
  if (!outcomes || outcomes.length === 0) return false;
  const publishDate = localDatePart(publishedAt);
  return outcomes.some(
    (o) => o.metricDate > publishDate && CORE_METRICS.some((k) => typeof o.metrics[k] === "number"),
  );
}

/** 回填待办：published 且未回填，T+1 提醒 / T+3 告警 */
function buildBackfillTodos(
  publishedItems: Content[],
  outcomeIndex: Map<string, PerformanceOutcome[]>,
  now: number,
): DashboardSummary["backfillTodos"] {
  return publishedItems
    .filter((c) => c.publishedAt && !hasBackfilled(outcomeIndex.get(c.id), c.publishedAt))
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
}

/** 成片就绪待发布：视频线终点（videoReadyAt）到了，稿件却没进发布流程——闭环就断在这 */
function buildVideoReadyTodos(contents: Content[], now: number): DashboardSummary["videoReadyTodos"] {
  return contents
    .filter((c) => c.videoReadyAt && !PUBLISH_TRACK_STATUSES.has(c.status))
    .map((c) => ({
      id: c.id, title: c.title, platform: c.platform ?? null,
      videoReadyAt: c.videoReadyAt!, daysSince: daysBetween(c.videoReadyAt!, now),
    }))
    .sort((a, b) => b.daysSince - a.daysSince);
}

/**
 * 登录态过期待办。null = 状态文件读失败（不是「没有待办」）——
 * 文件损坏走 readPullState 的重建默认（三平台全关 → 无待办），只有真 IO 故障才到这。
 */
async function loadPullLoginTodos(dataDir?: string): Promise<DashboardSummary["pullLoginTodos"] | null> {
  try {
    const state = await readPullState(dataDir);
    return PULL_PLATFORMS.filter(
      (p) => state.platforms[p].enabled && state.platforms[p].lastStatus === "needs_login",
    ).map((p) => ({
      platform: p,
      label: PULL_PLATFORM_LABELS[p],
      consoleUrl: PULL_PLATFORM_CONSOLES[p],
      lastSuccessAt: state.platforms[p].lastSuccessAt,
    }));
  } catch {
    return null;
  }
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
    persona: {
      summary: personaSummary(profile?.audiencePersona),
      calibrated: Boolean(profile?.audiencePersona?.calibratedAt),
    },
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

  // ── 回填待办（判据是 outcomes.jsonl,不是 content.performanceData——后者与「记录回流」
  //    的写入路径永不相遇,待办永远不消失,spec §1 D4） ──
  const outcomeIndex = await loadOutcomeIndex(dataDir);
  const backfillTodos = outcomeIndex === null ? [] : buildBackfillTodos(publishedItems, outcomeIndex, now);

  // ── 成片就绪待发布（视频线终点接发布线,spec §3.3） ──
  const videoReadyTodos = buildVideoReadyTodos(normalized, now);

  // ── 登录态过期待办（自动回流 spec §4.4）：扫一次码，数据继续自己回来 ──
  const pullLoginTodos = await loadPullLoginTodos(dataDir);

  // ── 灵感摘要（今日 top-3 可写：最新入库优先，带入库理由） ──
  const inspirations = topics.slice(0, INSPIRATION_LIMIT).map((t) => ({
    id: t.id, title: t.title, reason: t.reason ?? null, source: t.source ?? null, link: t.link ?? null,
  }));

  const isFirstRun = !profile || (!profile.styleCalibrated && contents.length === 0 && topics.length === 0);

  return {
    calibration, reviewQueue, backfillTodos,
    outcomesAvailable: outcomeIndex !== null,
    pullLoginTodos: pullLoginTodos ?? [],
    pullStateAvailable: pullLoginTodos !== null,
    videoReadyTodos, pipeline, inspirations, isFirstRun,
  };
}
