/**
 * 简报的作品表 / 分组 / 基线（选题会 spec §3）——纯函数，零 IO。
 *
 * 统计全部复用 metrics-window（天龄、分组、中位数、近龄读数）；这里只决定口径：
 * - 只用 D+3 / D+7（±1 天容差，标实际天龄）；
 * - 离群 = 最新播放 > 同平台作品中位数 5 倍，单列，不进分组与基线；
 * - n < 5 只列数，不给中位数（insufficient）。
 */
import { outcomeKey, type OutcomeMetrics } from "../flywheel/outcome-schema.js";
import { median, metricsNearAge, ageInDays, type AtAgeSnapshot, type EntityGroup } from "../flywheel/metrics-window.js";
import { MIN_BASELINE_SAMPLE } from "../retro/hypothesis-judge.js";
import { PULLABLE_METRICS, isUnverified } from "../insights/metric-review.js";
import type { WorkTag } from "../flywheel/platform-items.js";

export const OUTLIER_MULTIPLE = 5;
export const BET_DAYS = [3, 7] as const;
const UNTAGGED = "未标";

export interface WorkReading { metricDate: string; ageDays: number; metrics: OutcomeMetrics }
export interface WorkRow {
  key: string;
  platform: string;
  title: string;
  contentId: string | null;
  boundVia: "outcome" | "plan" | null;
  publishedAt: string | null;
  d3: WorkReading | null;
  d7: WorkReading | null;
  latest: WorkReading | null;
  format: string;
  persona: string;
  tagSource: "manual" | "meeting" | null;
  outlier: boolean;
}

export type Stat = { n: number; status: "ok"; median: number } | { n: number; status: "insufficient"; values: number[] };

export function statOf(values: number[]): Stat {
  if (values.length < MIN_BASELINE_SAMPLE) return { n: values.length, status: "insufficient", values };
  return { n: values.length, status: "ok", median: median(values) as number };
}

const reading = (at: AtAgeSnapshot | null): WorkReading | null =>
  at ? { metricDate: at.metricDate, ageDays: at.ageDays, metrics: at.metrics } : null;

/**
 * 作品标签的键：有平台作品 id 用 id（标题改了、绑定了都不变），没有才用 标题@北京日期。
 * 读的时候三把键都认（id 键、标题键、旧的作品键），绑定或补上 id 后旧标签不失联。
 */
export function workTagKeys(g: EntityGroup): { primary: string; all: string[] } {
  const itemId = [...g.snapshots].reverse().find((s) => s.platformItemId)?.platformItemId;
  const last = g.snapshots[g.snapshots.length - 1];
  const titleKey = outcomeKey({ ...last, contentId: null, metricDate: "" });
  const itemKey = itemId ? `${g.platform}:item:${itemId}` : null;
  return { primary: itemKey ?? titleKey, all: [...new Set([itemKey, titleKey, g.entityKey].filter((k): k is string => !!k))] };
}

export type MeetingTagLookup = (contentId: string | null) => { format: string; personaKey: string } | null;

export function buildWorkRows(
  groups: Array<EntityGroup & { boundVia: WorkRow["boundVia"] }>,
  tags: Record<string, WorkTag>,
  meetingTag: MeetingTagLookup,
): WorkRow[] {
  const rows = groups.map((g): WorkRow => {
    const last = g.snapshots[g.snapshots.length - 1];
    const keys = workTagKeys(g);
    const manual = keys.all.map((k) => tags[k]).find(Boolean);
    const fromMeeting = meetingTag(g.contentId);
    return {
      key: keys.primary, platform: g.platform, title: g.title, contentId: g.contentId, boundVia: g.boundVia,
      publishedAt: g.publishedAt,
      d3: reading(metricsNearAge(g.snapshots, g.publishedAt, 3)),
      d7: reading(metricsNearAge(g.snapshots, g.publishedAt, 7)),
      latest: last ? { metricDate: last.metricDate, ageDays: g.publishedAt ? ageInDays(g.publishedAt, last.metricDate) ?? -1 : -1, metrics: last.metrics } : null,
      format: manual?.format ?? fromMeeting?.format ?? UNTAGGED,
      persona: manual?.personaKey ?? fromMeeting?.personaKey ?? UNTAGGED,
      tagSource: manual && (manual.format || manual.personaKey) ? "manual" : fromMeeting ? "meeting" : null,
      outlier: false,
    };
  });
  markOutliers(rows);
  return rows;
}

/** 同平台最新播放中位数的 5 倍以上 = 离群 */
function markOutliers(rows: WorkRow[]): void {
  for (const platform of new Set(rows.map((r) => r.platform))) {
    const peers = rows.filter((r) => r.platform === platform);
    const mid = median(peers.flatMap((r) => typeof r.latest?.metrics.views === "number" ? [r.latest.metrics.views] : []));
    if (!mid || mid <= 0) continue;
    for (const r of peers) r.outlier = (r.latest?.metrics.views ?? 0) > mid * OUTLIER_MULTIPLE;
  }
}

const valueAt = (r: WorkRow, day: 3 | 7, metric: string): number | undefined => {
  const v = (day === 3 ? r.d3 : r.d7)?.metrics[metric as keyof OutcomeMetrics];
  return typeof v === "number" ? v : undefined;
};

export interface BaselineRow { platform: string; metric: string; label: string; day: 3 | 7; unverified: boolean; stat: Stat }

/** 每平台 × 可回流指标 × 天龄：中位数与 n；离群不进 */
export function buildBaselines(rows: WorkRow[]): BaselineRow[] {
  const platforms = [...new Set([...Object.keys(PULLABLE_METRICS), ...rows.map((r) => r.platform)])].sort();
  return platforms.flatMap((platform) => (PULLABLE_METRICS[platform] ?? []).flatMap((m) => BET_DAYS.map((day) => {
    const values = rows.filter((r) => r.platform === platform && !r.outlier).flatMap((r) => valueAt(r, day, m.metric) ?? []);
    return { platform, metric: m.metric, label: m.label, day, unverified: isUnverified(platform, m.metric), stat: statOf(values) };
  })));
}

export interface GroupRow { dimension: "format" | "persona"; platform: string; key: string; day: 3 | 7; metric: string; stat: Stat }

const GROUP_METRICS = ["views", "completion5s"] as const;

/** 按形式 / 画像分组：同平台同天龄的中位数 + n；未标的单独一组「未标」，离群不进 */
export function buildGroups(rows: WorkRow[]): GroupRow[] {
  const out: GroupRow[] = [];
  const clean = rows.filter((r) => !r.outlier);
  for (const dimension of ["format", "persona"] as const) {
    for (const platform of [...new Set(clean.map((r) => r.platform))].sort()) {
      const peers = clean.filter((r) => r.platform === platform);
      for (const key of [...new Set(peers.map((r) => r[dimension]))].sort()) {
        for (const day of BET_DAYS) for (const metric of GROUP_METRICS) {
          const values = peers.filter((r) => r[dimension] === key).flatMap((r) => valueAt(r, day, metric) ?? []);
          if (values.length) out.push({ dimension, platform, key, day, metric, stat: statOf(values) });
        }
      }
    }
  }
  return out;
}
