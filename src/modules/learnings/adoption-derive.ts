/**
 * 隐式采纳判定：发布时刻按「AI 成稿 → 实际发布出去的稿」的改动量自动判一次。
 *
 * 取代三键手动裁决——创始人从来不点，采纳率的分母就一直是空的。发布这个动作本身
 * 已经表达了「这稿我认了」，剩下要读的只是「改了多少」，而那是可算的。
 *
 * 判定只在发布时刻盖一次（同 publishedAt 纪律），且不覆盖已有裁决；创始人在编辑页
 * 「改判」时走 recordAdoption 整条覆盖，derived 标记自然消失。
 */
import { getContent, recordAdoption } from "../../storage/local-store.js";
import type { AdoptionRecord, AdoptionVerdict, Content } from "../../storage/local-store.js";

/** 比较窗口：正文再长也只看前 2000 字——首尾大改在这个窗口里一定看得出来 */
const COMPARE_LIMIT = 2000;

/**
 * 「小改」与「重写」的分界。0.5 = 半数以上的字符 bigram 被换掉，
 * 那已经不是打磨而是推倒重来了。
 */
const LIGHT_EDIT_FLOOR = 0.5;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, COMPARE_LIMIT);
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const g = text.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** 字符 bigram Dice 系数（0-1）。空白归一后不足 2 字符的一边：相等算 1，否则 0 */
export function bigramSimilarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;

  const gx = bigrams(x);
  const gy = bigrams(y);
  let overlap = 0;
  for (const [g, count] of gx) {
    const other = gy.get(g);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

export function deriveAdoptionVerdict(baseline: string, finalBody: string): AdoptionVerdict {
  if (normalize(baseline) === normalize(finalBody)) return "adopted";
  return bigramSimilarity(baseline, finalBody) >= LIGHT_EDIT_FLOOR ? "light_edit" : "rewritten";
}

/**
 * AI 成稿基线 = 时间上离「稿成」最近的那一版。generate-script 把占位稿转正时先取
 * draftReadyAt、再由 updateContent 落版本，两个时间戳差几毫秒是常态且方向不定，
 * 所以不能按「savedAt ≤ draftReadyAt」硬切——切错一毫秒基线就退回占位稿，
 * 正常成稿会被判成推倒重写。取最近邻没有这个脆弱点：占位稿早几分钟、人改稿晚几分钟，
 * 只有 AI 成稿那一版贴着稿成时刻。
 *
 * 已知边界：旧稿没有 draftReadyAt，只能回落 v1——而 v1 可能是占位稿，导致判定偏严。
 * 接受这个偏差，不做启发式修补：猜错的基线比缺失的基线更难查。
 */
function baselineBody(content: Content): string {
  const versions = content.versions ?? [];
  const readyAt = content.draftReadyAt ? Date.parse(content.draftReadyAt) : NaN;
  if (!Number.isNaN(readyAt) && versions.length > 0) {
    let best = versions[0];
    let bestGap = Math.abs(Date.parse(best.savedAt) - readyAt);
    for (const v of versions.slice(1)) {
      const gap = Math.abs(Date.parse(v.savedAt) - readyAt);
      if (gap <= bestGap) {
        best = v;
        bestGap = gap;
      }
    }
    return best.body;
  }
  return versions[0]?.body ?? content.body;
}

/**
 * 发布时刻推导并落库一次采纳判定。
 * 稿件不存在、或已有裁决（手动裁决 / 先前推导）→ 返回 null，不重判。
 */
export async function deriveAndRecordAdoption(
  contentId: string,
  dataDir?: string,
): Promise<AdoptionRecord | null> {
  const content = await getContent(contentId, dataDir);
  if (!content || content.adoption) return null;

  const verdict = deriveAdoptionVerdict(baselineBody(content), content.body);
  const updated = await recordAdoption(contentId, verdict, dataDir, undefined, undefined, { derived: true });
  return updated?.adoption ?? null;
}
