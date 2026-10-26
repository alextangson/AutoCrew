/**
 * 认稿那件对「由视频派生的英文版」多给的东西（Phase 3）：中英对照审阅页（网页）+ 还差什么 / 批准状态。
 * 和公众号文章一样：只在单看这一件（list 带 item_id）时用默认浏览器打开。
 */
import { getContent, type VideoKit } from "../../../storage/local-store.js";
import { missingAsNull } from "../../publish/review-gate/plan.js";
import type { InboxItem } from "../inbox.js";
import { enBriefLines, enReviewState, isEnEdition, renderEnReviewPage } from "../../en-edition/review.js";
import { openPage } from "./preview.js";
import type { ArticleView } from "./article-view.js";
import { enPackageState } from "../../en-edition/package.js";
import { enPackageApprovalText, writeEnPackagePreview } from "../../en-edition/package-preview.js";

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

/** 「英文发布包」那件：审阅页（缩略图、各平台文案、章节、成片）+ 还差什么 / 为什么重新出现 */
export async function enPackageView(item: InboxItem, dataDir: string, openIt: boolean): Promise<ArticleView | null> {
  if (item.type !== "en_package" || !item.content_id) return null;
  const s = await enPackageState(item.content_id, dataDir);
  if ("error" in s) return { lines: [`英文发布包审阅页没生成：${s.error}`], page: { name: "英文发布包", path: "", opened: false, reason: s.error } };
  const file = await writeEnPackagePreview(s, enPackageApprovalText(s), dataDir);
  const page = openIt ? await openPage(file) : { path: file, opened: false, reason: "没打开；要看就 list{item_id} 单看这一件，会用默认浏览器打开它" };
  const lines = [
    `《${item.title}》英文发布包`,
    ...kitLines(s.kits),
    `英文发布包审阅页（缩略图、YouTube 标题 / 描述 / 章节、X 帖子、成片文件）：${file}`,
    ...(item.detail.reopened ? [`重新出现的原因：批过之后变了——${String(item.detail.reopened)}`] : []),
    s.problems.length ? `还不能批：\n${s.problems.map((p, i) => `  ${i + 1}) ${p}`).join("\n")}` : "都齐了：他说「没问题」就批，批的是这一整包（也就是缩略图的批准）。",
  ];
  return { lines, page: { name: "英文发布包", ...page } };
}

/** 各平台文案直接写进 brief（不只给链接）：YouTube 标题 + 章节，X 帖子正文 */
function kitLines(kits: Record<string, VideoKit>): string[] {
  const out: string[] = [];
  const yt = kits.youtube, x = kits.x;
  if (yt) {
    out.push(`YouTube 标题：${yt.postTitle || "（没写）"}`);
    if (yt.chapters?.length) out.push(`YouTube 章节：${yt.chapters.map((c) => `${c.at} ${c.title}`).join(" / ")}`);
    out.push(`YouTube「AI use」：${(yt.aiDisclosure ?? "yes") === "yes" ? "Yes（克隆声音 + 对口型）" : "No"}`);
  }
  if (x) out.push(`X 帖子：${x.caption || x.postTitle || "（没写）"}`);
  return out;
}
