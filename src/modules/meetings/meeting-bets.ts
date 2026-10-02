/**
 * 上次会议下注的对账（选题会 spec §2.1 / §3 / 边界 1、2、9）。
 *
 * 裁决复用 hypothesis-judge（同平台同龄基线、MIN_BASELINE_SAMPLE=5、剔除试验稿自己）；
 * 这里只补三件 judge 不管的事：下注稿是谁（选题 → 稿件）、到没到期、回流健康不健康。
 * 「中」= 试验读数高于基线中位数（概率就是押的这个）；judge 的 ±20% 结论另列，不替换。
 */
import type { Content } from "../../storage/local-store.js";
import { ageInDays, metricsNearAgeAll, type EntityGroup } from "../flywheel/metrics-window.js";
import { normalizePlatform } from "../flywheel/outcome-schema.js";
import type { PlanEntry } from "../flywheel/plan-binding.js";
import { judgeHypothesis, type JudgeVerdict } from "../retro/hypothesis-judge.js";
import type { Hypothesis } from "../retro/hypotheses.js";
import { isUnverified } from "../insights/metric-review.js";

export type BetVerdict = "中" | "没中" | "数据不够" | "未到期" | "无法对账";

export interface BetReconcile {
  hypothesisId: string;
  topicId: string | null;
  slotId: string | null;
  statement: string;
  watch: { platform: string; metric: string; day: number };
  probability: number | null;
  verdict: BetVerdict;
  reason: string;
  judge: JudgeVerdict | null;
  contentIds: string[];
  /** 无法对账时列出各平台计划标题与日期，会上一句话确认绑定 */
  unmatched: Array<{ contentId: string; title: string; date: string }>;
  unverifiedMetric: boolean;
}

export interface BetContext {
  groups: Array<EntityGroup & { outlier?: boolean }>;
  contents: Content[];
  plans: PlanEntry[];
  /** 该平台回流是否健康（开启且 48h 内成功过）；不健康时说明原因 */
  pullHealthy: (platform: string) => { ok: boolean; reason: string };
  today: string;
}

function base(h: Hypothesis, contentIds: string[]): Omit<BetReconcile, "verdict" | "reason" | "judge" | "unmatched"> {
  const platform = normalizePlatform(h.scope.platform ?? "");
  return {
    hypothesisId: h.id, topicId: h.topicId ?? null, slotId: h.slotId ?? null, statement: h.statement,
    watch: { platform, metric: h.metricFocus, day: h.watchDay ?? 7 }, probability: h.probability ?? null,
    contentIds, unverifiedMetric: isUnverified(platform, h.metricFocus),
  };
}

/** 没有回流读数时：是还没发、回流不健康，还是发了却绑不上 */
function withoutReadings(b: ReturnType<typeof base>, ctx: BetContext): BetReconcile {
  const plans = ctx.plans.filter((p) => b.contentIds.includes(p.contentId) && p.platform === b.watch.platform);
  const published = plans.filter((p) => p.date <= ctx.today);
  const done = (verdict: BetVerdict, reason: string, unmatched: BetReconcile["unmatched"] = []): BetReconcile =>
    ({ ...b, verdict, reason, judge: null, unmatched });
  if (b.contentIds.length === 0) return done("未到期", "这条选题还没有稿件");
  if (published.length === 0) return done("未到期", `还没在 ${b.watch.platform} 发布（发布计划里没有到日子的条目）`);
  const age = Math.max(...published.map((p) => ageInDays(p.date, ctx.today) ?? 0));
  if (age < b.watch.day - 1) return done("未到期", `发布 ${age} 天，还没到 D+${b.watch.day}`);
  const pull = ctx.pullHealthy(b.watch.platform);
  if (!pull.ok) return done("数据不够", pull.reason);
  return done("无法对账", "按平台各自标题+北京日期匹配不上任何回流作品，请确认绑定",
    published.map((p) => ({ contentId: p.contentId, title: p.title, date: p.date })));
}

export function reconcileBet(h: Hypothesis, ctx: BetContext): BetReconcile {
  const fromTopic = h.topicId ? ctx.contents.filter((c) => c.topicId === h.topicId && c.status !== "archived").map((c) => c.id) : [];
  const contentIds = [...new Set([...h.contentIds, ...fromTopic])];
  const b = base(h, contentIds);
  const mine = ctx.groups.filter((g) => g.platform === b.watch.platform && g.contentId && contentIds.includes(g.contentId));
  if (mine.length === 0) return withoutReadings(b, ctx);
  const age = Math.max(...mine.map((g) => (g.publishedAt ? ageInDays(g.publishedAt, ctx.today) : null) ?? 0));
  if (age < b.watch.day - 1) return { ...b, verdict: "未到期", reason: `发布 ${age} 天，还没到 D+${b.watch.day}`, judge: null, unmatched: [] };
  const pull = ctx.pullHealthy(b.watch.platform);
  if (!pull.ok) return { ...b, verdict: "数据不够", reason: pull.reason, judge: null, unmatched: [] };
  const pool = ctx.groups.filter((g) => !g.outlier || mine.includes(g));
  const judge = judgeHypothesis({ ...h, contentIds, direction: "up" }, { aggregates: metricsNearAgeAll(pool, b.watch.day), ageDays: b.watch.day });
  const { testValue, baselineValue, relDiff, reason } = judge.evidence;
  if (relDiff === null || testValue === null || baselineValue === null) {
    return { ...b, verdict: "数据不够", reason, judge, unmatched: [] };
  }
  const verdict: BetVerdict = testValue > baselineValue ? "中" : "没中";
  return { ...b, verdict, reason: `D+${b.watch.day} ${testValue} vs 同平台同龄基线中位 ${baselineValue}（n=${judge.evidence.baselineSampleSize}）`, judge, unmatched: [] };
}
