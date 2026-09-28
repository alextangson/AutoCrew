/**
 * 数据页的「一行一条视频」（数据页规格 §F.33–36 / §G.39）——纯函数，读盘在 desktop/data-page.ts。
 *
 * 顺序：手动决定（最新一条说了算）→ 自动关联稿件（标题相近 + 发布日期差 ≤1 天，或平台作品 id 对上）
 * → 没稿件的老视频按「同一天 + 标题相近」合行 → 「拆开」的各占一行 → 「和上一行是同一条」并过去。
 */
import { normalizeTitle } from "./outcome-schema.js";
import { diceSimilarity } from "./outcome-store.js";
import type { LinkDecision } from "./outcome-links.js";

export interface Snapshot { metricDate: string; recordedAt: string | null; source: string; metrics: Record<string, number | null> }

export interface Work {
  key: string;
  platform: string;
  title: string;
  publishedAt: string | null;
  day: string | null;
  platformItemId: string | null;
  /** 回流时已由导入管线打上的稿件 id（当作自动关联，手动可改） */
  importedContentId: string | null;
  /** 旧 → 新 */
  snapshots: Snapshot[];
}

export interface ContentPlatformRef { platform: string; title: string | null; postId: string | null; day: string | null; published: boolean }
export interface ContentRef { id: string; title: string; day: string | null; platforms: ContentPlatformRef[] }

export interface DataRow {
  id: string;
  contentId: string | null;
  contentTitle: string | null;
  title: string;
  day: string | null;
  works: Work[];
  /** 稿件发布记录里已经公开的平台——有这个平台、没有数据 = 「未回流」 */
  publishedOn: string[];
  link: "manual" | "auto" | "none";
  /** 这一行最近的一条手动决定（撤销用） */
  decisionId: string | null;
}

export interface OutcomeLike {
  contentId: string | null;
  platform: string;
  platformTitle: string;
  platformItemId?: string | null;
  publishedAt: string | null;
  metricDate: string;
  recordedAt?: string;
  source: string;
  metrics: Record<string, number | null | undefined>;
}

/** 发布时间 → 北京时间的日期；纯日期原样 */
export function shanghaiDay(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
}

export function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export function workKey(o: Pick<OutcomeLike, "platform" | "platformTitle" | "platformItemId" | "publishedAt">): string {
  if (o.platformItemId) return `${o.platform}#${o.platformItemId}`;
  return `${o.platform}@${normalizeTitle(o.platformTitle) || o.platformTitle}@${shanghaiDay(o.publishedAt) ?? "unknown"}`;
}

/** 快照流水 → 作品（同一作品的多次快照收在一起） */
export function buildWorks(outcomes: OutcomeLike[]): Work[] {
  const byKey = new Map<string, Work>();
  // 同一作品早先的快照可能没带平台 id：先放带 id 的，没 id 的按「标题@日期」认回同一条
  const alias = new Map<string, string>();
  const ordered = [...outcomes].sort((a, b) => Number(!a.platformItemId) - Number(!b.platformItemId));
  for (const o of ordered) {
    const loose = workKey({ ...o, platformItemId: null });
    const key = o.platformItemId ? workKey(o) : alias.get(loose) ?? loose;
    if (o.platformItemId) alias.set(loose, key);
    const w = byKey.get(key) ?? {
      key, platform: o.platform, title: o.platformTitle, publishedAt: o.publishedAt, day: shanghaiDay(o.publishedAt),
      platformItemId: o.platformItemId ?? null, importedContentId: null, snapshots: [],
    };
    const metrics: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(o.metrics)) metrics[k] = typeof v === "number" ? v : null;
    w.snapshots.push({ metricDate: o.metricDate, recordedAt: o.recordedAt ?? null, source: o.source, metrics });
    if (o.contentId) w.importedContentId = o.contentId;
    byKey.set(key, w);
  }
  for (const w of byKey.values()) {
    w.snapshots.sort((a, b) => a.metricDate.localeCompare(b.metricDate) || (a.recordedAt ?? "").localeCompare(b.recordedAt ?? ""));
  }
  return [...byKey.values()];
}

export function latest(w: Work): Snapshot {
  return w.snapshots[w.snapshots.length - 1];
}

/** 标题相近：归一后相等、互相包含（≥6 字）、或 bigram 相似度 ≥0.6 */
export function titlesSimilar(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = normalizeTitle(a), y = normalizeTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))) return true;
  return diceSimilarity(x, y) >= 0.6;
}

/** 这条作品和这条稿件的吻合度：0 = 对不上；3 = 平台作品 id 对上；2 = 标题一样；1 = 标题相近 */
export function matchScore(w: Work, c: ContentRef): number {
  const plat = c.platforms.find((p) => p.platform === w.platform);
  if (plat?.postId && w.platformItemId && plat.postId === w.platformItemId) return 3;
  const day = plat?.day ?? c.day;
  if (!w.day || !day || dayDiff(w.day, day) > 1) return 0;
  const titles = [c.title, plat?.title ?? null];
  if (titles.some((t) => t && normalizeTitle(t) === normalizeTitle(w.title))) return 2;
  return titles.some((t) => titlesSimilar(w.title, t)) ? 1 : 0;
}

/** 每条作品的有效手动决定：后做的盖过先做的 */
export function effectiveDecisions(decisions: LinkDecision[]): Map<string, LinkDecision> {
  const out = new Map<string, LinkDecision>();
  for (const d of decisions) for (const w of d.works) out.set(w, d);
  return out;
}
