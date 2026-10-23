/**
 * 认稿那件对「由视频派生的公众号文章」多给的东西（Phase 2a）：图文审阅页（网页）+ 还差什么 / 批准状态。
 * 只在单看这一件（list 带 item_id）时用默认浏览器打开审阅页，免得每次列清单都弹浏览器。
 */
import { getContent } from "../../../storage/local-store.js";
import { missingAsNull } from "../../publish/review-gate/plan.js";
import type { InboxItem } from "../inbox.js";
import { articleReviewState, isDerivedArticle, renderReviewPage, reviewBriefLines } from "../../wechat-article/review.js";
import { openPage } from "./preview.js";

export interface ArticleView { lines: string[]; page: { name: string; path: string; opened: boolean; reason: string } }

export async function articleDraftView(item: InboxItem, dataDir: string, openIt: boolean): Promise<ArticleView | null> {
  if (item.type !== "draft" || !item.content_id) return null;
  const content = await getContent(item.content_id, dataDir).catch(missingAsNull);
  if (!isDerivedArticle(content)) return null;
  const s = await articleReviewState(item.content_id, dataDir);
  if ("error" in s) return { lines: [`图文审阅页没生成：${s.error}`], page: { name: "图文审阅页", path: "", opened: false, reason: s.error } };
  const file = await renderReviewPage(s, dataDir);
  const page = openIt ? await openPage(file) : { path: file, opened: false, reason: "没打开；要看就 list{item_id} 单看这一件，会用默认浏览器打开它" };
  return { lines: reviewBriefLines(s, file), page: { name: "图文审阅页", ...page } };
}
