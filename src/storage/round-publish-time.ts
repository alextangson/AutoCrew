/**
 * 已发布稿的「本轮发布时间」与「最近 N 条」保留名单：NAS 归档（会删本机文件）、发布即备份、「我的内容/5 已发布」共用这一份口径。
 *
 * 保守（创始人 09-30）：按本体走的稿只认本轮**可信观察**（发布计划 / 数据回流按作品 id）里真实的公开 / 定时时间；
 * 「我发了」、AI 说法、只有排序占位时间的旧回执都不算。定不出本轮时间 → null：不归档、不备份，归档报告列「待确认发布时间」。
 * 旧稿（没按本体走）照用 publishedAt。
 */
import type { Content } from "./local-store.js";
import { readProductionDocOrEmpty } from "./production-store.js";
import { ontologyApplies } from "../modules/production/publish-gate.js";
import { explainContent, explainContext } from "../modules/production/read.js";
import { receiptsOfRound } from "../modules/production/receipts.js";

export const KEEP_PUBLISHED = 5;

export async function roundPublishTime(c: Content, data: string): Promise<string | null> {
  if (!(await ontologyApplies(c, data))) return c.publishedAt ?? null;
  const doc = await readProductionDocOrEmpty(c.id, data);
  const times = receiptsOfRound(doc).live.filter((s) => s.by === "trusted" && s.fact_id).map((s) => {
    const f = doc.facts.find((x) => x.id === s.fact_id);
    return f?.published_at ? Date.parse(f.published_at) : NaN;
  }).filter((t) => !Number.isNaN(t));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export async function withRoundPublishTime(c: Content, data: string): Promise<Content> {
  return { ...c, publishedAt: await roundPublishTime(c, data) };
}

export interface PublishedSet {
  /** 在「已发布」栏的稿，publishedAt 已换成本轮发布时间（定不出 = null） */
  published: Content[];
  /** 最近 KEEP_PUBLISHED 条（定不出时间的当最新，一律保留）：视图只显示它们，归档不动它们 */
  keep: Set<string>;
  /** 逐条读失败的（不挡其他稿） */
  errors: Array<{ content: Content; error: string }>;
}

/** 已发布栏 + 保留名单：逐条隔离，一条坏记录不挡整库 */
export async function publishedSet(contents: Content[], data: string, keepN = KEEP_PUBLISHED): Promise<PublishedSet> {
  const ctx = await explainContext(data);
  const published: Content[] = [];
  const errors: PublishedSet["errors"] = [];
  for (const c of contents) {
    try {
      if ((await explainContent(c, data, ctx)).column !== "已发布") continue;
      published.push({ ...c, publishedAt: await roundPublishTime(c, data) });
    } catch (e) { errors.push({ content: c, error: e instanceof Error ? e.message : String(e) }); }
  }
  const rank = (c: Content) => c.publishedAt ?? "9999";
  const keep = new Set([...published].sort((a, b) => rank(b).localeCompare(rank(a))).slice(0, keepN).map((c) => c.id));
  return { published, keep, errors };
}
