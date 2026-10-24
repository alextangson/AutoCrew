/**
 * 认稿那件对「由视频派生的英文版」多给的东西（Phase 3）：中英对照审阅页（网页）+ 还差什么 / 批准状态。
 * 和公众号文章一样：只在单看这一件（list 带 item_id）时用默认浏览器打开。
 */
import { getContent } from "../../../storage/local-store.js";
import { missingAsNull } from "../../publish/review-gate/plan.js";
import type { InboxItem } from "../inbox.js";
import { enBriefLines, enReviewState, isEnEdition, renderEnReviewPage } from "../../en-edition/review.js";
import { openPage } from "./preview.js";
import type { ArticleView } from "./article-view.js";

export async function enDraftView(item: InboxItem, dataDir: string, openIt: boolean): Promise<ArticleView | null> {
  if (item.type !== "draft" || !item.content_id) return null;
  const content = await getContent(item.content_id, dataDir).catch(missingAsNull);
  if (!isEnEdition(content)) return null;
  const s = await enReviewState(item.content_id, dataDir);
  if ("error" in s) return { lines: [`中英对照审阅页没生成：${s.error}`], page: { name: "英文版中英对照", path: "", opened: false, reason: s.error } };
  const file = await renderEnReviewPage(s, dataDir);
  const page = openIt ? await openPage(file) : { path: file, opened: false, reason: "没打开；要看就 list{item_id} 单看这一件，会用默认浏览器打开它" };
  return { lines: enBriefLines(s, file), page: { name: "英文版中英对照", ...page } };
}
