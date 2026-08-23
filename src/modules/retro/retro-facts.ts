/**
 * 复盘事实层（spec §5.2/§5.4）——**证据由代码选择与聚合，模型只读摘要**。
 *
 * 废除了「任意前 20 条原始 outcome 进 prompt」的做法（codex #31）：原始快照是累计值，
 * 丢 20 条给模型，模型只会把老作品的一生当成本周战绩。现在进 prompt 的是三视图摘要：
 * 增量（本期新增多少）、cohort（本期发的稿跑得怎么样）、D+7 定龄（跨作品公平比较），
 * 外加台账里开放假设**已经由代码裁决好的**结论与证据。
 *
 * 跨平台纪律：绝对量的小计一律带平台前缀分列；率类才做跨平台中位数。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { listContents, getDataDir, type Content } from "../../storage/local-store.js";
import { listOutcomes } from "../flywheel/outcome-store.js";
import {
  deltaInWindow,
  publishCohort,
  metricsAtAgeAll,
  median,
  COUNTER_METRICS,
  type CounterMetric,
  type CounterTotals,
  type WindowDelta,
  type CohortResult,
  type AgeCohortEntry,
  type RateMetrics,
} from "../flywheel/metrics-window.js";
import { loadProfile, personaSummary, goalSummary } from "../profile/creator-profile.js";
import { listOpenHypotheses, type Hypothesis } from "./hypotheses.js";
import { judgeHypothesis, JUDGE_AGE_DAYS, type JudgeVerdict } from "./hypothesis-judge.js";
import { computeProductionTiming, timingFactsBlock, type ProductionTiming } from "./production-timing.js";

const DAY_MS = 86_400_000;

const COUNTER_LABELS: Record<CounterMetric, string> = {
  views: "播放",
  impressions: "曝光",
  likes: "赞",
  comments: "评",
  shares: "转",
  favorites: "藏",
  follows: "粉",
};

function counterText(totals: CounterTotals, sign = ""): string {
  const parts = COUNTER_METRICS.flatMap((k) =>
    typeof totals[k] === "number" ? [`${COUNTER_LABELS[k]} ${sign}${Math.round(totals[k] as number)}`] : [],
  );
  return parts.length ? parts.join(" · ") : "无指标";
}

function rateText(rates: RateMetrics): string {
  const parts: string[] = [];
  if (typeof rates.completionRate === "number") parts.push(`完播率 ${rates.completionRate.toFixed(1)}%`);
  if (typeof rates.engagementRate === "number") parts.push(`互动率 ${rates.engagementRate.toFixed(1)}%`);
  return parts.join(" · ");
}

const BASIS_LABEL = {
  prior_snapshot: "对照窗口前快照",
  in_window_span: "窗口内首尾差分(起点到首个快照那段未计)",
  published_in_window: "本期发布,累计值即增量",
} as const;

/** 增量视图摘要：绝对量按平台分列，永不跨平台加总 */
function deltaBlock(delta: WindowDelta): string {
  if (delta.items.length === 0 && delta.noBaseline.length === 0) {
    return "本期增量:无任何作品在窗口内有数据快照(不是 0 增长,是没数据)。";
  }
  const lines = ["本期增量(同作品相邻快照差分,累计快照不当本期表现):"];
  for (const p of delta.byPlatform) {
    lines.push(`- [${p.platform}] ${p.works} 篇有增量:${counterText(p.totals, "+")}${rateText(p.rates) ? ` | ${rateText(p.rates)}` : ""}`);
    const top = delta.items
      .filter((i) => i.platform === p.platform)
      .sort((a, b) => (b.delta.views ?? 0) - (a.delta.views ?? 0))
      .slice(0, 3);
    for (const i of top) {
      lines.push(`  · 《${i.title}》${counterText(i.delta, "+")}(${BASIS_LABEL[i.basis]})`);
    }
  }
  const clamped = delta.items.filter((i) => i.clamped.length > 0);
  if (clamped.length > 0) {
    const detail = clamped
      .slice(0, 3)
      .map((i) => `《${i.title}》${i.clamped.map((k) => `${COUNTER_LABELS[k]} ${i.rawDelta[k]}`).join("/")}`)
      .join("；");
    lines.push(`- ${clamped.length} 篇出现负增量(平台修数),已夹到 0 计入:${detail}`);
  }
  if (delta.noBaseline.length > 0) {
    lines.push(`- ${delta.noBaseline.length} 篇定不出基线,未计入增量(快照有缺口,不插值):${delta.noBaseline.slice(0, 3).map((n) => `《${n.title}》`).join("")}`);
  }
  return lines.join("\n");
}

/** cohort 摘要：本期发布的稿件，累计值必须配着龄期看 */
function cohortBlock(cohort: CohortResult): string {
  if (cohort.items.length === 0) return "本期发布 cohort:窗口内没有发布任何稿件。";
  const lines = ["本期发布作品表现(cohort:只含本窗口发布的稿,累计值配龄期看):"];
  for (const p of cohort.byPlatform) {
    lines.push(`- [${p.platform}] ${p.works} 篇(${p.withData} 篇有数据):${counterText(p.totals)}`);
    for (const i of cohort.items.filter((x) => x.platform === p.platform && x.cumulative)) {
      const rates = rateText(i.rates);
      lines.push(`  · 《${i.title}》D+${i.ageDays ?? "?"}:${counterText(i.cumulative as CounterTotals)}${rates ? ` | ${rates}` : ""}`);
    }
  }
  if (cohort.missingData > 0) {
    lines.push(`- ${cohort.missingData} 篇发布后还没有任何数据快照(未回流,不是表现为 0)`);
  }
  return lines.join("\n");
}

/** D+N 定龄对比：绝对量按平台中位，率类允许跨平台 */
function atAgeBlock(entries: AgeCohortEntry[], ageDays: number): string {
  if (entries.length === 0) return `D+${ageDays} 定龄对比:还没有作品攒够 ${ageDays} 天的快照,本期不做定龄比较。`;
  const lines = [`D+${ageDays} 定龄对比(每个作品取龄期 ≥${ageDays} 天的首个快照,跨作品才公平):`];
  const platforms = [...new Set(entries.map((e) => e.platform))].sort();
  for (const platform of platforms) {
    const rows = entries.filter((e) => e.platform === platform);
    const views = median(rows.flatMap((r) => (typeof r.at.metrics.views === "number" ? [r.at.metrics.views] : [])));
    const engage = median(rows.flatMap((r) => (typeof r.at.rates.engagementRate === "number" ? [r.at.rates.engagementRate] : [])));
    const done = median(rows.flatMap((r) => (typeof r.at.rates.completionRate === "number" ? [r.at.rates.completionRate] : [])));
    const parts = [
      views !== null ? `播放中位 ${Math.round(views)}` : null,
      done !== null ? `完播率中位 ${done.toFixed(1)}%` : null,
      engage !== null ? `互动率中位 ${engage.toFixed(1)}%` : null,
    ].filter(Boolean);
    lines.push(`- [${platform}] 到龄 ${rows.length} 篇:${parts.join(" · ") || "无可比指标"}`);
  }
  if (platforms.length > 1) {
    const allEngage = median(entries.flatMap((e) => (typeof e.at.rates.engagementRate === "number" ? [e.at.rates.engagementRate] : [])));
    const allDone = median(entries.flatMap((e) => (typeof e.at.rates.completionRate === "number" ? [e.at.rates.completionRate] : [])));
    const parts = [
      allDone !== null ? `完播率中位 ${allDone.toFixed(1)}%` : null,
      allEngage !== null ? `互动率中位 ${allEngage.toFixed(1)}%` : null,
    ].filter(Boolean);
    lines.push(`- 跨平台只比率类(绝对量不可跨平台):${parts.join(" · ") || "无率类指标"}`);
  }
  return lines.join("\n");
}

export interface JudgedHypothesis {
  hypothesis: Hypothesis;
  verdict: JudgeVerdict;
}

/** 假设台账摘要：裁决已由代码算定，模型只解释 */
function hypothesesBlock(judged: JudgedHypothesis[]): string {
  if (judged.length === 0) {
    return "假设台账:当前没有开放假设。本期请提出 1-3 条可证伪的新假设(数据太少就少提)。";
  }
  const lines = ["开放假设与本期裁决(**裁决由代码算定,不得改判**,你只解释为什么):"];
  for (const { hypothesis: h, verdict } of judged) {
    const e = verdict.evidence;
    lines.push(
      `- [${verdict.status}] ${h.id}《${h.statement}》焦点=${h.metricFocus} 方向=${h.direction}` +
        (h.scope.platform ? ` 范围=${h.scope.platform}` : "") +
        `\n  证据:${e.reason};试验样本 ${e.sampleSize} 篇,对照样本 ${e.baselineSampleSize} 篇,口径 D+${e.ageDays};${e.note}`,
    );
  }
  return lines.join("\n");
}

export interface RetroFacts {
  fromDate: string;
  toDate: string;
  block: string;
  timing: ProductionTiming;
  /** 本期代码裁决结果——写台账与结果回传都用它，模型碰不到 */
  judged: JudgedHypothesis[];
  /** 数据账本读取失败的原因——「读不到」不等于「没数据」，必须显式 */
  outcomesError?: string;
  /** 假设台账读取失败的原因：本期做不了裁决，报告与结果都要明说 */
  ledgerError?: string;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 读失败与读到空是两回事：前者要报「不可用」，后者才是「没数据」（codex #14 同款纪律） */
async function readOrReport<T>(load: Promise<T>, fallback: T): Promise<{ value: T; error?: string }> {
  try {
    return { value: await load };
  } catch (err) {
    return { value: fallback, error: errText(err) };
  }
}

/**
 * 有视频构建活动的稿件 = 落过 `video/state.json` 的（视频状态按设计不进 Content，
 * 见视频 spec §2.1，只能靠目录判定）。用来把「剪过片却没成片戳」与「压根没剪过」
 * 分开——后者不该出现在任何缺戳计数里。
 */
async function videoActiveIds(ids: string[], dataDir?: string): Promise<string[]> {
  const base = getDataDir(dataDir);
  const hits = await Promise.all(
    ids.map(async (id) => {
      try {
        await fs.access(path.join(base, "contents", id, "video", "state.json"));
        return id;
      } catch {
        return null;
      }
    }),
  );
  return hits.filter((id): id is string => id !== null);
}

function contentLine(c: Content): string {
  return `- 《${c.title}》(${c.platform || "未定平台"}·${c.status})`;
}

/** 产出盘点（稿件维度，与数据维度分开算） */
function outputBlock(contents: Content[], fromIso: string): { block: string; published: Content[] } {
  const created = contents.filter((c) => c.createdAt >= fromIso);
  const published = contents.filter((c) => c.publishedAt && c.publishedAt >= fromIso);
  const judged = contents.filter((c) => c.adoption?.recordedAt && c.adoption.recordedAt >= fromIso);
  const adopted = judged.filter((c) => c.adoption && ["adopted", "light_edit"].includes(c.adoption.verdict)).length;
  const block = [
    `本期新建稿件 ${created.length} 篇:`,
    created.length ? created.slice(0, 15).map(contentLine).join("\n") : "(无)",
    `本期发布 ${published.length} 篇:`,
    published.length ? published.slice(0, 15).map(contentLine).join("\n") : "(无)",
    `本期稿件裁决 ${judged.length} 篇` +
      (judged.length ? `,采纳率 ${Math.round((adopted / judged.length) * 100)}%(采纳+轻改 ${adopted})` : ""),
  ].join("\n");
  return { block, published };
}

type Profile = Awaited<ReturnType<typeof loadProfile>>;

/** 抬头：窗口 + 定位 + 目标 + 画像（未填/未校准都如实标注，不给模型留想象空间） */
function headerBlock(profile: Profile, window: string): string {
  const persona = personaSummary(profile?.audiencePersona, { allTiers: true }) || "未建立";
  const calibrated = profile?.audiencePersona?.calibratedAt
    ? `(校准于 ${profile.audiencePersona.calibratedAt.slice(0, 10)})`
    : "(未校准)";
  return [
    `复盘窗口:${window}`,
    `创作者定位:${profile?.industry || "未填写"}`,
    `目标:${goalSummary(profile?.goal) || "未设定"}`,
    `受众画像:${persona}${calibrated}`,
  ].join("\n");
}

/** 数据段三态：读失败 / 一条都没有 / 三视图摘要——三种话术不许混为一谈 */
function dataSection(
  read: { error?: string; count: number },
  delta: WindowDelta,
  cohort: CohortResult,
  atAge: AgeCohortEntry[],
): string {
  if (read.error) {
    return `数据表现:数据账本读取失败(${read.error})——本期数据不可用。如实说明「读不到数据」,不要说创作者没回填,更不要编造数据。`;
  }
  if (read.count === 0) {
    return "数据表现:数据账本里一条快照都没有。如实说明数据缺口(不要断言原因:可能是还没回流,也可能是导入/抓取没跑),不要编造数据表现。";
  }
  return [deltaBlock(delta), "", cohortBlock(cohort), "", atAgeBlock(atAge, JUDGE_AGE_DAYS)].join("\n");
}

export async function gatherFacts(days: number, dataDir?: string): Promise<RetroFacts> {
  const fromIso = new Date(Date.now() - days * DAY_MS).toISOString();
  const fromDate = fromIso.slice(0, 10);
  const toDate = new Date().toISOString().slice(0, 10);

  const [profile, contents, outcomesRead, ledgerRead] = await Promise.all([
    loadProfile(dataDir),
    listContents(dataDir).catch(() => []),
    readOrReport(listOutcomes(dataDir), []),
    readOrReport(listOpenHypotheses(dataDir), []),
  ]);
  const outcomes = outcomesRead.value;

  const delta = deltaInWindow(outcomes, fromDate, toDate);
  const cohort = publishCohort(contents, outcomes, fromDate, toDate);
  const atAge = metricsAtAgeAll(outcomes, JUDGE_AGE_DAYS);
  const judged: JudgedHypothesis[] = ledgerRead.value.map((h) => ({
    hypothesis: h,
    verdict: judgeHypothesis(h, { aggregates: atAge }),
  }));

  const output = outputBlock(contents, fromIso);
  const timing = computeProductionTiming(
    output.published,
    await videoActiveIds(output.published.map((c) => c.id), dataDir),
  );

  const parts: string[] = [
    headerBlock(profile, `${fromDate} ~ ${toDate}(${days} 天)`),
    "",
    output.block,
    "",
    dataSection({ error: outcomesRead.error, count: outcomes.length }, delta, cohort, atAge),
    "",
    ledgerRead.error
      ? `假设台账:读取失败(${ledgerRead.error})——本期不做假设复盘,也不要提新假设(台账写不进去)。`
      : hypothesesBlock(judged),
    "",
    timingFactsBlock(timing),
  ];
  const facts: RetroFacts = { fromDate, toDate, block: parts.join("\n"), timing, judged };
  if (outcomesRead.error) facts.outcomesError = outcomesRead.error;
  if (ledgerRead.error) facts.ledgerError = ledgerRead.error;
  return facts;
}
