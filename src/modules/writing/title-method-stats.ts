/**
 * 标题方法试用期统计（docs/2026-10-03-title-methods-spec.md §五.5、§六、§七.3）。
 *
 * 按方法 id 汇总已发布的稿和点击率。点击率取三平台数据回流（outcomes），缺了如实写「无数据」，
 * 不拿空值当 0 算平均；没有方法 id 的旧稿归「未标记」，不回填猜测；「自拟」单列，不算进任何方法。
 * 满 4 条带方法的已发布稿给中期报告提醒，满 8 条给终版提醒。
 */
import { listContents, normalizeLegacyStatus, type Content } from "../../storage/local-store.js";
import { listLatestOutcomes } from "../flywheel/outcome-store.js";
import { normalizePlatform, type PerformanceOutcome } from "../flywheel/outcome-schema.js";
import { reviewedRow } from "../insights/metric-review.js";
import { activeTitleMethods } from "../calibration/title-library.js";
import { findTitleMethod, SELF_WRITTEN, titleMethodGuide, titleMethodIds, titleNumberWarnings } from "./title-methods.js";

export const UNTAGGED = "未标记";
export const NO_DATA = "无数据";
export const TRIAL_MID = 4;
export const TRIAL_FINAL = 8;

export interface MethodRow {
  method: string;
  name: string;
  published: number;
  /** 有点击率数据的条数 */
  withData: number;
  /** 只对有数据的条目求平均；一条都没有 = null（展示为「无数据」） */
  avgClickRate: number | null;
  clickRate: string;
}

export interface TitleMethodReport {
  publishedWithMethod: number;
  stage: "none" | "mid" | "final";
  rows: MethodRow[];
  reminder?: string;
}

/** 这条稿发出去用的方法：只认本平台发布包里记的；旧稿没有 = 未标记 */
function methodOf(c: Content): string {
  const kit = c.videoKit;
  return kit && kit.platform === c.platform && kit.titleMethod ? kit.titleMethod : UNTAGGED;
}

/** 点击率（百分比）：平台给的封面点击率优先，没有时用 播放 ÷ 曝光；都缺 = undefined，不当 0 */
export function clickRateOf(raw: PerformanceOutcome | undefined): number | undefined {
  // 被复核理由点名的指标先剔掉（与洞察统计同口径），待复核的数不进方法均值
  const o = raw ? reviewedRow(raw) : null;
  if (!o) return undefined;
  const m = o.metrics;
  if (typeof m.coverClickRate === "number" && Number.isFinite(m.coverClickRate)) return m.coverClickRate;
  if (typeof m.views === "number" && typeof m.impressions === "number" && m.impressions > 0) return (m.views / m.impressions) * 100;
  return undefined;
}

function rowFor(method: string, rates: Array<number | undefined>): MethodRow {
  const known = rates.filter((r): r is number => r !== undefined);
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  const name = method === UNTAGGED || method === SELF_WRITTEN ? method : findTitleMethod(method)?.name ?? method;
  const clickRate = avg === null ? NO_DATA : `${avg.toFixed(2)}%（${known.length}/${rates.length} 条有数据）`;
  return { method, name, published: rates.length, withData: known.length, avgClickRate: avg, clickRate };
}

export function trialStage(n: number): TitleMethodReport["stage"] {
  return n >= TRIAL_FINAL ? "final" : n >= TRIAL_MID ? "mid" : "none";
}

function reminderFor(stage: TitleMethodReport["stage"], n: number): string | undefined {
  if (stage === "none") return undefined;
  const which = stage === "final" ? "终版" : "中期";
  return `标题方法试用期：已有 ${n} 条带方法 id 的稿发布，可以给创始人出${which}报告（autocrew_pre_publish action="title_methods" 拿统计）。方法留、改、删要走升级门：autocrew_insights calib_bump{target:"title_library"}${stage === "final" ? "（终版可能过门成「已验证」）" : "（中期只能出「判断」，不改库）"}。`;
}

/** 一条已发布稿在试用期里的样本：点击率剔掉待复核指标；flagged = 有回流但点击率被复核剔掉 */
export interface TitlePostSample { id: string; title: string; method: string; clickRate: number | undefined; flagged: boolean }

export function titlePostSamples(contents: Content[], outcomes: PerformanceOutcome[]): TitlePostSample[] {
  const published = contents.filter((c) => normalizeLegacyStatus(c.status) === "published");
  return published.map((c) => {
    const o = outcomes.find((x) => x.contentId === c.id && x.platform === normalizePlatform(c.platform || ""));
    const clickRate = clickRateOf(o);
    return { id: c.id, title: c.videoKit?.postTitle || c.title, method: methodOf(c), clickRate, flagged: !!o?.needsReview && clickRate === undefined };
  });
}

/** 纯函数：已发布稿 + 回流数据 → 按方法汇总 */
export function aggregateTitleMethods(contents: Content[], outcomes: PerformanceOutcome[]): TitleMethodReport {
  const groups = new Map<string, Array<number | undefined>>();
  for (const p of titlePostSamples(contents, outcomes)) groups.set(p.method, [...(groups.get(p.method) ?? []), p.clickRate]);
  const rows = [...groups.entries()].map(([m, rates]) => rowFor(m, rates));
  const n = rows.filter((r) => r.method !== UNTAGGED && r.method !== SELF_WRITTEN).reduce((a, r) => a + r.published, 0);
  const stage = trialStage(n);
  return { publishedWithMethod: n, stage, rows, reminder: reminderFor(stage, n) };
}

export async function loadTitlePosts(dataDir?: string): Promise<{ report: TitleMethodReport; posts: TitlePostSample[] }> {
  const [contents, outcomes] = await Promise.all([listContents(dataDir), listLatestOutcomes(dataDir)]);
  return { report: aggregateTitleMethods(contents, outcomes), posts: titlePostSamples(contents, outcomes) };
}

export async function titleMethodReport(dataDir?: string): Promise<TitleMethodReport> {
  const [contents, outcomes] = await Promise.all([listContents(dataDir), listLatestOutcomes(dataDir)]);
  return aggregateTitleMethods(contents, outcomes);
}

/** autocrew_pre_publish action=title_methods：方法库指引 + 试用期统计 */
export async function titleMethodsAction(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const platform = typeof params.platform === "string" ? params.platform.trim() : undefined;
  const dataDir = (params._dataDir as string) || undefined;
  const [report, lib] = await Promise.all([titleMethodReport(dataDir), activeTitleMethods(dataDir)]);
  return {
    ok: true,
    guide: titleMethodGuide(platform, lib),
    method_ids: titleMethodIds(lib),
    self_written: SELF_WRITTEN,
    trial_report: report,
  };
}

/** 交包回执里的提示（不拦）：标题数字在正文找不到；试用期满 4 / 8 条提醒出报告 */
export async function kitTitleAdvisories(postTitle: string, body: string, dataDir?: string): Promise<Record<string, unknown>> {
  const warnings = titleNumberWarnings(postTitle, body);
  const trial = (await titleMethodReport(dataDir)).reminder;
  return { ...(warnings.length ? { warnings } : {}), ...(trial ? { title_trial_reminder: trial } : {}) };
}
