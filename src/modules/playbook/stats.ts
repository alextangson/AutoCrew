/**
 * 每个手册版本的表现（spec §4，按 §9.3/9.4/9.8 修订）：只摆数，不下结论。
 * - 归属只看记下的版本：定稿时 draftFinal.playbook；没记 = 未归版本（不按日期判断）。
 * - 已定稿 = 创始人在工作台点了有效的「定了」（draftFinal 在）；没定的算「进行中」，不进轮数、不判放弃。
 * - 轮数 = feedback 里带原话、且记的版本和定稿那一版对得上的条数；换体裁前的单独计。
 * - 发布数据：抖音作品 D+3 / D+7 正好那天的快照，没有就留空，不拿别的天代替。
 */
import { listOutcomes } from "../flywheel/outcome-store.js";
import { normalizePlatform, shanghaiDate, type PerformanceOutcome } from "../flywheel/outcome-schema.js";
import { draftHash } from "../../storage/draft-hash.js";
import { listContents, type Content } from "../../storage/local-store.js";
import type { PlaybookManifest, PlaybookPin } from "./types.js";

export const MIN_SAMPLE = 3;
export const SAMPLE_LOW = "样本不够";

const samePin = (a: PlaybookPin | undefined, b: PlaybookPin) => Boolean(a && a.id === b.id && a.version === b.version);
/** 有效定稿：和工作台认的一样，定稿指纹对得上当前稿（之后改过正文就不算） */
const finalPin = (c: Content): PlaybookPin | undefined => (c.draftFinal && c.draftFinal.draftHash === draftHash(c) ? c.draftFinal.playbook : undefined);
const finalized = (c: Content) => Boolean(c.draftFinal && c.draftFinal.draftHash === draftHash(c));
const live = (c: Content) => !c.deletedAt && c.status !== "archived";

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** 一条作品在 D+n 那天的快照指标；没有那天就 null */
function snapshotOn(rows: PerformanceOutcome[], publishedAt: string, n: number): Record<string, number | null> | null {
  // metricDate 是上海日期：先把发布时间换成上海日期再加天数
  const day = addDays(shanghaiDate(publishedAt), n);
  const o = rows.find((r) => r.metricDate === day);
  if (!o) return null;
  const m = o.metrics, views = typeof m.views === "number" && m.views > 0 ? m.views : null;
  const per1k = (v: number | undefined) => (views && typeof v === "number" ? Math.round((v / views) * 10_000) / 10 : null);
  return { bounce2s: m.bounce2s ?? null, shares_per_1k: per1k(m.shares), favorites_per_1k: per1k(m.favorites) };
}

function avg(snaps: Array<Record<string, number | null> | null>, key: string): number | null {
  const xs = snaps.map((s) => s?.[key]).filter((v): v is number => typeof v === "number");
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
}

function publishSignal(finals: Content[], outcomes: PerformanceOutcome[]): Record<string, unknown> {
  const works = finals.flatMap((c) => {
    const rows = outcomes.filter((o) => o.contentId === c.id && normalizePlatform(o.platform) === "douyin" && !o.retracted && o.publishedAt);
    const publishedAt = rows[0]?.publishedAt;
    return publishedAt ? [{ content_id: c.id, title: c.title, published_at: publishedAt, d3: snapshotOn(rows, publishedAt, 3), d7: snapshotOn(rows, publishedAt, 7) }] : [];
  });
  const summary = (k: "d3" | "d7") => ({ count: works.filter((w) => w[k]).length, bounce2s: avg(works.map((w) => w[k]), "bounce2s"), shares_per_1k: avg(works.map((w) => w[k]), "shares_per_1k"), favorites_per_1k: avg(works.map((w) => w[k]), "favorites_per_1k") });
  return { published: works.length, works, d3: summary("d3"), d7: summary("d7"), label: works.length < MIN_SAMPLE ? SAMPLE_LOW : null };
}

function versionStats(pin: PlaybookPin, contents: Content[], outcomes: PerformanceOutcome[]): Record<string, unknown> {
  const finals = contents.filter((c) => samePin(finalPin(c), pin));
  const rounds = finals.map((c) => (c.draftPath?.feedback ?? []).filter((f) => f.founder_words && samePin(f.playbook, pin)).length);
  const preSwitch = finals.reduce((n, c) => n + (c.draftPath?.feedback ?? []).filter((f) => f.founder_words && f.playbook && !samePin(f.playbook, pin)).length, 0);
  const inProgress = contents.filter((c) => !finalized(c) && samePin(c.draftPath?.angle?.playbook, pin)).length;
  return {
    version: pin.version, finalized: finals.length, in_progress: inProgress,
    rounds: { median: median(rounds), min: rounds.length ? Math.min(...rounds) : null, max: rounds.length ? Math.max(...rounds) : null },
    pre_switch_rounds: preSwitch, label: finals.length < MIN_SAMPLE ? SAMPLE_LOW : null,
    publish: publishSignal(finals, outcomes),
  };
}

/** 纯计算：给定稿件与回流快照，算每本每版的统计 + 未归版本的稿数 */
export function computeStats(m: PlaybookManifest, contents: Content[], outcomes: PerformanceOutcome[]): Record<string, unknown> {
  const drafts = contents.filter((c) => c.draftPath && live(c));
  const unattributed = drafts.filter((c) => !c.draftPath?.angle?.playbook && !finalPin(c)).length;
  const by_playbook = Object.fromEntries(m.playbooks.map((e) => [e.id, e.versions.map((v) => versionStats({ id: e.id, version: v.version }, drafts, outcomes))]));
  return { by_playbook, unattributed, min_sample: MIN_SAMPLE };
}

export async function playbookStats(m: PlaybookManifest, dataDir?: string): Promise<Record<string, unknown>> {
  const [contents, outcomes] = await Promise.all([listContents(dataDir), listOutcomes(dataDir)]);
  return computeStats(m, contents, outcomes);
}
