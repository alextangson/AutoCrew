/**
 * 派生稿认稿那件在网页面板里直接显示的内容（2026-10-25「认稿要做的简单一点」）：
 * 英文版 = 中英对照表（和 en-script-review.html 同一份数据：en-edition/review.ts 的 enReviewState），
 * 公众号文章 = 选定标题 + 正文 + 还差什么（articleReviewState）。只读，不写审阅页文件。
 * 读不出来（脚本没写、稿不在）照实回原因，面板显示「为什么看不了」。
 */
import { getContent } from "../../storage/local-store.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { enApprovalText, enReviewState, isEnEdition } from "../en-edition/review.js";
import { segmentBudget, wordCount } from "../en-edition/script.js";
import { approvalText, articleReviewState, isDerivedArticle } from "../wechat-article/review.js";
import { articleChars } from "../wechat-article/package.js";

export interface EnSegmentView {
  index: number; startMs: number; endMs: number; zh: string; en: string; keyword: string | null; changed: string | null;
  slotS: number; estimatedS: number; words: number; over: boolean;
  swaps: Array<{ from: string; to: string; reason: string; factual: boolean; verified: boolean; evidenceId: string | null }>;
}
export type DerivedReview =
  | { ok: true; kind: "en_edition"; title: string; segments: EnSegmentView[]; problems: string[]; approval: string; hash: string }
  | { ok: true; kind: "wechat_article"; title: string; chosenTitle: string | null; titleOptions: string[]; body: string; chars: number; images: number; problems: string[]; approval: string; sourceNote: string | null; hash: string }
  | { ok: false; code: string; error: string };

async function enView(id: string, dataDir: string): Promise<DerivedReview> {
  const s = await enReviewState(id, dataDir);
  if ("error" in s) return { ok: false, code: s.code, error: s.error };
  const segments = s.script.segments.map((g): EnSegmentView => {
    const b = segmentBudget(g);
    return {
      index: g.index, startMs: g.startMs, endMs: g.endMs, zh: g.zh, en: g.en, keyword: g.keyword ?? null, changed: g.changed ?? null,
      slotS: b.slotS, estimatedS: b.estimatedS, words: wordCount(g.en), over: b.over,
      swaps: g.swaps.map((w) => ({ from: w.from, to: w.to, reason: w.reason, factual: Boolean(w.factual), verified: Boolean(w.evidenceId && s.evidence.has(w.evidenceId)), evidenceId: w.evidenceId ?? null })),
    };
  });
  return { ok: true, kind: "en_edition", title: s.content.title, segments, problems: s.problems, approval: enApprovalText(s), hash: s.hash };
}

async function articleView(id: string, dataDir: string): Promise<DerivedReview> {
  const s = await articleReviewState(id, dataDir);
  if ("error" in s) return { ok: false, code: s.code, error: s.error };
  const body = s.content.body ?? "";
  return {
    ok: true, kind: "wechat_article", title: s.content.title, chosenTitle: s.pkg.chosenTitle ?? null, titleOptions: s.pkg.titleOptions, body, chars: articleChars(body),
    images: s.images.entries.length, problems: s.problems, approval: approvalText(s), sourceNote: s.pkg.sourceNote ?? null, hash: s.hash,
  };
}

export async function derivedReview(contentId: string, dataDir: string): Promise<DerivedReview> {
  const content = await getContent(contentId, dataDir).catch(missingAsNull);
  if (!content) return { ok: false, code: "not_found", error: `稿件不存在：${contentId}` };
  if (isEnEdition(content)) return enView(contentId, dataDir);
  if (isDerivedArticle(content)) return articleView(contentId, dataDir);
  return { ok: false, code: "not_derived", error: "这条不是由视频派生的英文版或公众号文章" };
}
