/**
 * 按发布计划绑定作品 ↔ 稿件（选题会 spec §5.2）。
 *
 * matchDraft 只认 `content.platform === 行平台` 且标题相近；一条稿发三个平台、各平台标题不同时
 * 只有一个平台认得上。发布计划 `06-publish/publish-plan.json` 里**每个平台各自**写了 title +
 * scheduled_at：同平台、归一化标题相等、且计划时间与作品发布时间是同一个北京日期 → 认这篇稿。
 * 多篇稿同时命中 = 有歧义，不认（宁可列「未绑定」让人确认，也不张冠李戴）。
 *
 * **只在内存里用（简报 / 下注对账），不写回 outcomes**：写回会让作品换成 contentId 键，
 * listOutcomes 随即丢掉它所有未绑定的早期快照（D+3/D+7 就没了），按旧键打的标签也跟着失联。
 */
import { getDataDir, listContents, type Content } from "../../storage/local-store.js";
import { readPublishPlanRaw } from "../../storage/publish-record.js";
import { normalizePlatform, normalizeTitle, shanghaiDate } from "./outcome-schema.js";

export interface PlanEntry { contentId: string; platform: string; title: string; date: string }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 一份计划里每个平台的 title + 北京日期；读不到或缺字段的条目跳过（只是少一条绑定线索） */
export function planEntriesOf(contentId: string, raw: string | null): PlanEntry[] {
  if (!raw) return [];
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return []; }
  if (!isObj(json) || !Array.isArray(json.platforms)) return [];
  return json.platforms.flatMap((entry) => {
    if (!isObj(entry)) return [];
    const pub = isObj(entry.publication) ? entry.publication : {};
    // 实际公开时间优先于计划时间：定时被改过时 scheduled_at 会对不上作品真实发布日
    const when = text(pub.published_at) || text(entry.scheduled_at) || text(pub.scheduled_at);
    const platform = text(entry.platform);
    const title = text(entry.title);
    if (!platform || !title || !when || Number.isNaN(Date.parse(when))) return [];
    return [{ contentId, platform: normalizePlatform(platform), title, date: shanghaiDate(when) }];
  });
}

/** 全工作区的计划条目（归档稿除外）。单篇读失败只少这一篇的线索，不拖垮整批匹配 */
export async function loadPlanEntries(dataDir?: string, contents?: Content[]): Promise<PlanEntry[]> {
  const list = (contents ?? await listContents(dataDir)).filter((c) => c.status !== "archived");
  const out: PlanEntry[] = [];
  for (const c of list) {
    const raw = await readPublishPlanRaw(c.id, getDataDir(dataDir)).catch(() => null);
    out.push(...planEntriesOf(c.id, raw));
  }
  return out;
}

/** 唯一命中的 contentId；没命中或多篇命中 → null */
export function matchPlanEntry(entries: PlanEntry[], platform: string, title: string, publishedAt: string | null): string | null {
  const norm = normalizeTitle(title);
  if (!norm || !publishedAt) return null;
  const date = shanghaiDate(publishedAt);
  const target = normalizePlatform(platform);
  const hits = new Set(entries.filter((e) => e.platform === target && e.date === date && normalizeTitle(e.title) === norm)
    .map((e) => e.contentId));
  return hits.size === 1 ? [...hits][0] : null;
}
