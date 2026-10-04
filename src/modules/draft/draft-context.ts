/**
 * start 返回的三份上下文（实现规格 · start；会审 #3/#8）：
 * ① 档案：定位、受众卡、抖音生效的写作规则、口吻样本——这就是全部写作规则；
 * ② 账号爆款：抖音、发布日期最近 90 天，播放与 5 秒完播各一份前 10，附快照日期与样本数，缺的指标照实标缺；
 * ③ 同系列最近 5 条的主线 + 开头。另把一手材料单列：亲历只能从这里来。
 */
import { listLatestOutcomes } from "../flywheel/outcome-store.js";
import { normalizePlatform, type PerformanceOutcome } from "../flywheel/outcome-schema.js";
import { reviewedRow } from "../insights/metric-review.js";
import { loadProfile, personaSummary, rulesForPlatform } from "../profile/creator-profile.js";
import { buildSeriesSnapshot } from "../writing/series-memory.js";
import { collectOwnMaterial } from "../research/own-material.js";
import { loadLatestBrief } from "../research/brief-store.js";
import { getDataDir, listContents, type Content, type Topic } from "../../storage/local-store.js";
import { DRAFT_PLATFORM } from "./draft-types.js";

const HIT_WINDOW_DAYS = 90;
const HIT_TOP = 10;
const SAMPLE_MAX = 600;

export async function profileContext(dataDir?: string): Promise<Record<string, unknown>> {
  const profile = await loadProfile(dataDir);
  if (!profile) return { missing: true, note: "还没有创作者档案：写作规则与口吻样本为空，照实告诉创始人" };
  return {
    positioning: profile.expressionPersona || profile.industry || null,
    audience: personaSummary(profile.audiencePersona, { allTiers: true }) || null,
    rules: rulesForPlatform(profile, DRAFT_PLATFORM).map((r) => r.rule),
    voice_samples: (profile.voiceSamples ?? []).slice(0, 5).map((s) => s.slice(0, SAMPLE_MAX)),
    never: profile.styleBoundaries?.never ?? [],
  };
}

function hitRow(o: PerformanceOutcome) {
  const m = o.metrics;
  return {
    title: o.platformTitle,
    published_at: o.publishedAt,
    views: typeof m.views === "number" ? m.views : "缺",
    completion5s: typeof m.completion5s === "number" ? m.completion5s : "缺",
    metric_date: o.metricDate,
  };
}

function rankBy(rows: PerformanceOutcome[], key: "views" | "completion5s") {
  return rows.filter((r) => typeof r.metrics[key] === "number")
    .sort((a, b) => (b.metrics[key] as number) - (a.metrics[key] as number))
    .slice(0, HIT_TOP).map(hitRow);
}

export async function hitsContext(dataDir?: string, now = Date.now()): Promise<Record<string, unknown>> {
  const since = now - HIT_WINDOW_DAYS * 86_400_000;
  const rows = (await listLatestOutcomes(dataDir))
    .filter((o) => normalizePlatform(o.platform) === DRAFT_PLATFORM && !o.retracted)
    .filter((o) => { const t = o.publishedAt ? Date.parse(o.publishedAt) : NaN; return Number.isFinite(t) && t >= since && t <= now; })
    .map(reviewedRow).filter((o): o is PerformanceOutcome => o !== null);
  const snapshot = rows.reduce((max, o) => (o.metricDate > max ? o.metricDate : max), "");
  return {
    window_days: HIT_WINDOW_DAYS,
    sample_size: rows.length,
    snapshot_date: snapshot || null,
    by_views: rankBy(rows, "views"),
    by_completion5s: rankBy(rows, "completion5s"),
    ...(rows.length === 0 ? { note: "最近 90 天没有可用的抖音回流数据；「为什么可能爆」只能引对标视频的真实数字" } : {}),
  };
}

function mainLineOf(c: Content | undefined, entries: Array<{ id: string; text: string }>): string | null {
  return c?.draftPath?.angle?.main_line ?? entries.find((e) => e.id === "thesis")?.text ?? null;
}

export async function seriesContext(content: Pick<Content, "id" | "topicId">, dataDir?: string): Promise<unknown[]> {
  const contents = await listContents(dataDir);
  const byId = new Map(contents.map((c) => [c.id, c]));
  const snap = buildSeriesSnapshot(contents, DRAFT_PLATFORM, { contentId: content.id, topicId: content.topicId });
  return snap.items.slice(0, 5).map((item) => ({
    title: item.title,
    label: item.label,
    main_line: mainLineOf(byId.get(item.content_id), item.entries) ?? "（没记主线）",
    opening: item.entries.find((e) => e.id === "structure:opening" || e.id === "opening")?.text ?? "",
  }));
}

/**
 * 选题描述只有创始人一句灵感建的选题才是他的原话：workflow prepare 建的（source=inspiration），
 * 和 autocrew_draft start{inspiration} 建的（source=autocrew_draft，描述就是那句灵感）。雷达摘要、搜索片段、手建题都证明不了。
 */
const FOUNDER_TOPIC_SOURCES = new Set(["inspiration", "autocrew_draft"]);
const founderTopicText = (t: Topic): string | undefined => (FOUNDER_TOPIC_SOURCES.has(t.source ?? "") ? t.description?.trim() || undefined : undefined);

/** 选题上有创始人出处的原话：灵感建题、选卡 / 自定角度原话、最新简报里的原始要求、同选题各稿 start 时的灵感与立意原话 */
async function founderSaid(topic: Topic, dataDir?: string): Promise<Array<{ source: string; text: string }>> {
  const brief = await loadLatestBrief(topic.id, getDataDir(dataDir)).catch(() => null);
  const others = (await listContents(dataDir)).filter((c) => c.topicId === topic.id && !c.deletedAt);
  const raw: Array<[string, string | undefined]> = [
    ["灵感建题原话", founderTopicText(topic)],
    ["选卡原话", topic.selectedAngle?.founderWords],
    ["自定角度原话", topic.founderAngle?.founderWords],
    ["创作要求", brief?.creativeTask?.requirements],
    ...others.flatMap((c): Array<[string, string | undefined]> => [
      [`稿件「${c.title}」灵感原话`, c.draftPath?.inspiration],
      [`稿件「${c.title}」立意原话`, c.draftPath?.angle?.founder_words],
    ]),
  ];
  const seen = new Set<string>();
  return raw.filter(([, t]) => { const k = t?.trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .map(([source, text]) => ({ source, text: text!.trim() }));
}

/** 一手材料：创始人的灵感原话、选题上他留过的话 + 他自己口播的转写片段（AI 起草的放行稿不算） */
export async function firsthandContext(topic: Topic | null, dataDir?: string, inspiration?: string): Promise<Record<string, unknown>> {
  if (!topic) return { founder_words: inspiration ?? null, founder_said: [], transcripts: [] };
  const material = await collectOwnMaterial(getDataDir(dataDir), { id: topic.id, title: topic.title, description: topic.description }, { maxChars: 6000 });
  return {
    founder_words: inspiration || founderTopicText(topic) || null,
    founder_said: await founderSaid(topic, dataDir),
    transcripts: material.chunks.filter((c) => c.kind === "transcript").map((c) => ({ id: c.id, title: c.title, text: c.text, same_topic: c.sameTopic })),
    rule: "亲历只能来自这里；没有就不写亲历",
  };
}
