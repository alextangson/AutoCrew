/**
 * autocrew_dashboard tool — Content Dashboard with batch operations.
 *
 * Provides a bird's-eye view of the content pipeline:
 * - Status breakdown with counts
 * - Weekly/monthly production stats
 * - Pending action items
 * - Content calendar view
 * - Batch operations (review, publish, rewrite)
 */
import { Type } from "@sinclair/typebox";
import { listContents, listTopics, type Content } from "../storage/local-store.js";
import { loadProfile } from "../modules/profile/creator-profile.js";

export const dashboardSchema = Type.Object({
  action: Type.Unsafe<"overview" | "calendar" | "pending" | "batch_review" | "batch_transition">({
    type: "string",
    enum: ["overview", "calendar", "pending", "batch_review", "batch_transition"],
    description:
      "Action: 'overview' full dashboard, 'calendar' content by date, 'pending' actionable items, " +
      "'batch_review' review all draft_ready, 'batch_transition' move multiple contents to a target status.",
  }),
  target_status: Type.Optional(Type.String({ description: "Target status for batch_transition." })),
  content_ids: Type.Optional(Type.Array(Type.String(), { description: "Content IDs for batch operations. If omitted, operates on all eligible." })),
  days: Type.Optional(Type.Number({ description: "Number of days to look back for stats. Default: 7." })),
});

// --- Helpers ---

function isWithinDays(dateStr: string, days: number): boolean {
  const date = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return date >= cutoff;
}

function groupByStatus(contents: Content[]): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const c of contents) {
    groups[c.status] = (groups[c.status] || 0) + 1;
  }
  return groups;
}

function groupByPlatform(contents: Content[]): Record<string, number> {
  const groups: Record<string, number> = {};
  for (const c of contents) {
    const p = c.platform || "unspecified";
    groups[p] = (groups[p] || 0) + 1;
  }
  return groups;
}

// --- Actions ---

async function overview(params: Record<string, unknown>) {
  const dataDir = (params._dataDir as string) || undefined;
  const days = (params.days as number) || 7;

  const [contents, topics, profile] = await Promise.all([
    listContents(dataDir),
    listTopics(dataDir),
    loadProfile(dataDir),
  ]);

  const recentContents = contents.filter(c => isWithinDays(c.createdAt, days));
  const recentTopics = topics.filter(t => isWithinDays(t.createdAt, days));

  const byStatus = groupByStatus(contents);
  const byPlatform = groupByPlatform(contents);

  // Pending actions
  const needsReview = contents.filter(c => c.status === "draft_ready").length;
  const needsPublish = contents.filter(c => c.status === "publish_ready").length;
  const inRevision = contents.filter(c => c.status === "revision").length;
  // 阶段制起：「等封面」就是 cover_pending 这一个阶段——approved 的视频稿要先过剪辑
  const needsCover = contents.filter(c => c.status === "cover_pending").length;

  // Published stats
  const published = contents.filter(c => c.status === "published");
  const publishedThisPeriod = published.filter(c => c.publishedAt && isWithinDays(c.publishedAt, days));

  return {
    ok: true,
    action: "overview",
    period: `${days}天`,
    totals: {
      topics: topics.length,
      contents: contents.length,
      published: published.length,
    },
    recentActivity: {
      newTopics: recentTopics.length,
      newContents: recentContents.length,
      publishedThisPeriod: publishedThisPeriod.length,
    },
    byStatus,
    byPlatform,
    pendingActions: {
      needsReview,
      needsPublish,
      inRevision,
      needsCover,
      total: needsReview + needsPublish + inRevision + needsCover,
    },
    profileLevel: profile?.styleCalibrated ? "calibrated" : profile?.industry ? "basic" : "new",
    writingRulesCount: profile?.writingRules.length || 0,
  };
}

async function calendar(params: Record<string, unknown>) {
  const dataDir = (params._dataDir as string) || undefined;
  const days = (params.days as number) || 30;

  const contents = await listContents(dataDir);
  const recent = contents.filter(c => isWithinDays(c.createdAt, days));

  // Group by date (YYYY-MM-DD)
  const byDate: Record<string, Array<{ id: string; title: string; status: string; platform?: string }>> = {};
  for (const c of recent) {
    const date = c.createdAt.split("T")[0];
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push({
      id: c.id,
      title: c.title,
      status: c.status,
      platform: c.platform,
    });
  }

  // Sort dates descending
  const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
  const calendarEntries = sortedDates.map(date => ({
    date,
    count: byDate[date].length,
    items: byDate[date],
  }));

  return {
    ok: true,
    action: "calendar",
    period: `${days}天`,
    totalDays: sortedDates.length,
    totalItems: recent.length,
    calendar: calendarEntries,
  };
}

async function pending(params: Record<string, unknown>) {
  const dataDir = (params._dataDir as string) || undefined;
  const contents = await listContents(dataDir);

  const items = contents
    .filter(c => ["draft_ready", "revision", "approved", "editing", "cover_pending", "publish_ready"].includes(c.status))
    .map(c => ({
      id: c.id,
      title: c.title,
      status: c.status,
      platform: c.platform,
      createdAt: c.createdAt,
      suggestedAction: getSuggestedAction(c.status),
    }))
    .sort((a, b) => {
      // 越靠近发布越先办；剪辑/封面排在 approved 之前——它们是已经开工的稿
      const priority: Record<string, number> = {
        publish_ready: 0,
        draft_ready: 1,
        revision: 2,
        cover_pending: 3,
        editing: 4,
        approved: 5,
      };
      return (priority[a.status] ?? 6) - (priority[b.status] ?? 6);
    });

  return {
    ok: true,
    action: "pending",
    count: items.length,
    items,
  };
}

function getSuggestedAction(status: string): string {
  switch (status) {
    case "draft_ready": return "运行审核 (autocrew_review)";
    case "revision": return "修改后重新审核";
    case "approved": return "视频稿推进到「剪辑」；文字稿直接跑发布前检查";
    case "editing": return "去剪辑台把成片做出来（挂 A-roll → 选段 → 审片）";
    case "cover_pending": return "去封面台定封面，再推进到「待发布」";
    case "publish_ready": return "发布 (autocrew_publish clipboard)";
    default: return "";
  }
}

async function batchReview(params: Record<string, unknown>) {
  const dataDir = (params._dataDir as string) || undefined;
  const contentIds = params.content_ids as string[] | undefined;

  const contents = await listContents(dataDir);
  const eligible = contents.filter(c => {
    if (contentIds && contentIds.length > 0) {
      return contentIds.includes(c.id) && c.status === "draft_ready";
    }
    return c.status === "draft_ready";
  });

  // Return the list of eligible content for the AI agent to review
  // The actual review is done by the agent calling autocrew_review for each
  return {
    ok: true,
    action: "batch_review",
    eligibleCount: eligible.length,
    eligible: eligible.map(c => ({
      id: c.id,
      title: c.title,
      platform: c.platform,
    })),
    instruction: eligible.length > 0
      ? `请依次对以下 ${eligible.length} 篇内容执行 autocrew_review action=full_review`
      : "没有待审核的内容",
  };
}

async function batchTransition(params: Record<string, unknown>) {
  const dataDir = (params._dataDir as string) || undefined;
  const targetStatus = params.target_status as string;
  const contentIds = params.content_ids as string[] | undefined;

  if (!targetStatus) {
    return { ok: false, error: "target_status is required for batch_transition" };
  }

  if (!contentIds || contentIds.length === 0) {
    return { ok: false, error: "content_ids is required for batch_transition" };
  }

  // Return the batch instruction for the agent to execute
  return {
    ok: true,
    action: "batch_transition",
    targetStatus,
    contentIds,
    instruction: `请依次对以下 ${contentIds.length} 篇内容执行 autocrew_content action=transition target_status=${targetStatus}`,
  };
}

// --- Execute ---

export async function executeDashboard(params: Record<string, unknown>) {
  const action = (params.action as string) || "overview";

  switch (action) {
    case "overview": return overview(params);
    case "calendar": return calendar(params);
    case "pending": return pending(params);
    case "batch_review": return batchReview(params);
    case "batch_transition": return batchTransition(params);
    default: return { ok: false, error: `Unknown action: ${action}` };
  }
}
