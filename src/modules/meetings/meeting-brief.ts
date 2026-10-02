/**
 * `meeting_brief`：选题会的确定性简报（选题会 spec §3），不调模型。
 *
 * 会上提到的每个数字都要出自这里。冷启动（回流刚开、同龄基线不足 5 条）照样出简报，
 * 但顶部写明，基线一律 insufficient——不拿累计数冒充同龄比较。
 */
import { shanghaiDate } from "../flywheel/outcome-schema.js";
import { PULL_PLATFORMS, PULL_PLATFORM_LABELS, type MetricsPullState } from "../flywheel/pull-state.js";
import { PULLABLE_METRICS } from "../insights/metric-review.js";
import { loadBriefInputs, type BriefInputs } from "./brief-inputs.js";
import { buildBaselines, buildGroups, buildWorkRows, type WorkRow } from "./meeting-works.js";
import { reconcileBet, type BetReconcile } from "./meeting-bets.js";
import type { MeetingRecord } from "./meeting-store.js";

export const PULL_STALE_MS = 48 * 3600_000;

export interface PlatformHealth { platform: string; label: string; enabled: boolean; lastSuccessAt: string | null; status: "未开启" | "从未成功" | "过期" | "正常" }

export function pullHealth(pull: MetricsPullState, now: Date): PlatformHealth[] {
  return PULL_PLATFORMS.map((platform) => {
    const s = pull.platforms[platform];
    const last = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : NaN;
    const status = !s.enabled ? "未开启" : Number.isNaN(last) ? "从未成功" : now.getTime() - last > PULL_STALE_MS ? "过期" : "正常";
    return { platform, label: PULL_PLATFORM_LABELS[platform], enabled: s.enabled, lastSuccessAt: s.lastSuccessAt, status };
  });
}

/** 作品 → 会议位上定的形式/画像（作品没手工标签时的第二来源） */
function meetingTagLookup(inputs: BriefInputs) {
  const slots = new Map(inputs.meetings.flatMap((m) => m.slots.map((s) => [`${m.date}|${s.slotId}`, s] as const)));
  return (contentId: string | null) => {
    const topicId = inputs.contents.find((c) => c.id === contentId)?.topicId;
    const slot = inputs.topics.find((t) => t.id === topicId)?.meetingSlot;
    const hit = slot ? slots.get(`${slot.meetingDate}|${slot.slotId}`) : undefined;
    return hit ? { format: hit.format, personaKey: hit.persona.key } : null;
  };
}

function reconcileLast(inputs: BriefInputs, rows: WorkRow[], health: PlatformHealth[], today: string) {
  const previous: MeetingRecord | undefined = inputs.meetings.find((m) => m.date < today);
  if (!previous) return { meetingDate: null, bets: [] as BetReconcile[] };
  const outlier = new Set(rows.filter((r) => r.outlier).map((r) => r.key));
  const groups = inputs.groups.map((g) => ({ ...g, outlier: outlier.has(g.entityKey) }));
  const pullHealthy = (platform: string) => {
    const h = health.find((x) => x.platform === platform);
    return h?.status === "正常" ? { ok: true, reason: "" } : { ok: false, reason: `${h?.label ?? platform}回流${h?.status ?? "不在自动回流范围"}，读数不可靠` };
  };
  const bets = inputs.hypotheses.filter((h) => h.meetingDate === previous.date)
    .map((h) => reconcileBet(h, { groups, contents: inputs.contents, plans: inputs.plans, pullHealthy, today }));
  return { meetingDate: previous.date, bets };
}

function headline(health: PlatformHealth[], rows: WorkRow[], coldStart: boolean, inputs: BriefInputs): string[] {
  const lines = health.filter((h) => h.status !== "正常").map((h) => `${h.label}回流${h.status}：相关下注只能判「数据不够」`);
  const unbound = rows.filter((r) => !r.contentId).length;
  if (unbound) lines.push(`${unbound} 个作品未绑定稿件（见 works 里 contentId 为空的行），会上一句话确认绑定`);
  if (coldStart) lines.push("冷启动：同平台同龄（D+3/D+7）基线都不足 5 条，只列数不下结论；不拿累计值冒充同龄比较");
  const unverified = unverifiedMetrics();
  if (unverified.length) lines.push(`量纲未核的指标（只作参考）：${unverified.map((u) => `${u.platform} ${u.metric}`).join("、")}`);
  if (inputs.invalidRows) lines.push(`${inputs.invalidRows} 行回流数据不合 schema，已排除`);
  return [...lines, ...inputs.warnings];
}

export async function buildMeetingBrief(dataDir?: string, now = new Date()) {
  const inputs = await loadBriefInputs(dataDir);
  const today = shanghaiDate(now.toISOString());
  const rows = buildWorkRows(inputs.groups, inputs.tags, meetingTagLookup(inputs));
  const health = pullHealth(inputs.pull, now);
  const baselines = buildBaselines(rows);
  const coldStart = baselines.every((b) => b.stat.status === "insufficient");
  return {
    generatedAt: now.toISOString(), today, timezone: "Asia/Shanghai",
    attention: headline(health, rows, coldStart, inputs),
    health: { platforms: health, unboundWorks: rows.filter((r) => !r.contentId).length, coldStart,
      unverifiedMetrics: unverifiedMetrics() },
    works: rows.filter((r) => !r.outlier),
    outliers: rows.filter((r) => r.outlier),
    untagged: rows.filter((r) => r.format === "未标" || r.persona === "未标").map((r) => ({ key: r.key, platform: r.platform, title: r.title, format: r.format, persona: r.persona })),
    groups: buildGroups(rows),
    baselines,
    pendingBets: reconcileLast(inputs, rows, health, today),
    availableMetrics: PULLABLE_METRICS,
    personas: personaNames(inputs),
    rules: [
      "引用分组/基线必须带 n；status=insufficient（n<5）只列数，不下结论。",
      "比较只在同平台同天龄（D+3/D+7，±1 天）间做；离群作品（>5× 同平台中位数）单列，不进基线。",
      "下注的 watch.metric 只能从 availableMetrics 对应平台里选；标 unverified 的指标只能参考。",
      "会上提到的数字都出自本简报，不凭记忆；本简报读不到就停会报错。",
    ],
  };
}

function unverifiedMetrics(): Array<{ platform: string; metric: string; label: string }> {
  return Object.entries(PULLABLE_METRICS).flatMap(([platform, list]) =>
    list.filter((m) => m.unverified).map((m) => ({ platform, metric: m.metric, label: "未核" })));
}

function personaNames(inputs: BriefInputs): Record<string, string> {
  const p = inputs.profile?.audiencePersona;
  return Object.fromEntries((["core", "adjacent", "surprise"] as const).flatMap((k) => p?.[k]?.name ? [[k, p[k]!.name]] : []));
}

export type MeetingBrief = Awaited<ReturnType<typeof buildMeetingBrief>>;
