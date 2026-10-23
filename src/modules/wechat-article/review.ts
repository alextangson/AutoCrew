/**
 * 一条派生公众号文章的审阅状态（Phase 2a）：包、配图、还差什么、整包指纹、批准还有没有效、源视频是否过期。
 * 审阅页、「等你拍板」的认稿那件、认稿决定、发布前核对都读这一份，不各算各的。
 */
import { getContent, type Content } from "../../storage/local-store.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { getArticleImageReview, type ArticleImageReview } from "../publish/article-images.js";
import { checkArtifactApproval, type ApprovalCheck } from "../lineage/artifact-approval.js";
import { staleReason } from "../lineage/lineage.js";
import { articleChars, packageHash, packageProblems, readArticlePackage, suggestedCreationSource, type ArticlePackage } from "./package.js";
import { writeArticlePreview } from "./preview.js";

export interface ArticleReviewState {
  content: Content;
  pkg: ArticlePackage;
  images: ArticleImageReview;
  problems: string[];
  hash: string;
  approval: ApprovalCheck;
  stale: string | null;
}

export const isDerivedArticle = (c: Pick<Content, "derivedFrom"> | null | undefined): boolean => c?.derivedFrom?.kind === "wechat_article";

export async function articleReviewState(contentId: string, dataDir: string, opts: { fresh?: boolean } = {}): Promise<ArticleReviewState | { error: string; code: string }> {
  const content = await getContent(contentId, dataDir).catch(missingAsNull);
  if (!content) return { code: "not_found", error: `稿件不存在：${contentId}` };
  if (!isDerivedArticle(content)) return { code: "not_derived_article", error: "这条不是由视频派生的公众号文章" };
  const [pkg, images] = await Promise.all([readArticlePackage(contentId, dataDir), getArticleImageReview(contentId, dataDir)]);
  const hash = await packageHash(content, pkg, images);
  const stale = await staleReason(content, dataDir, opts);
  const problems = [...(stale ? [stale] : []), ...(await packageProblems(content, pkg, images))];
  return { content, pkg, images, problems, hash, approval: checkArtifactApproval(pkg.approval, hash), stale };
}

export function approvalText(s: Pick<ArticleReviewState, "pkg" | "approval">): string {
  if (s.approval.ok) return `已批准（${s.pkg.approval!.approvedAt}）`;
  return s.pkg.approval ? `批准已失效：${s.approval.reason}` : "还没批";
}

/** 写审阅页，返回绝对路径 */
export async function renderReviewPage(s: ArticleReviewState, dataDir: string): Promise<string> {
  return writeArticlePreview({
    contentId: s.content.id, title: s.content.title, body: s.content.body ?? "", pkg: s.pkg, entries: s.images.entries,
    chars: articleChars(s.content.body ?? ""), problems: s.problems, suggestedSource: suggestedCreationSource(s.images),
    approval: approvalText(s), ...(s.pkg.sourceNote ? { sourceNote: s.pkg.sourceNote } : {}),
  }, dataDir);
}

/** 认稿那件的 brief 补充：还差什么、批准状态、审阅页 */
export function reviewBriefLines(s: ArticleReviewState, page: string): string[] {
  return [
    `图文审阅页（标题候选、配图、封面、创作来源都在里面）：${page}`,
    s.problems.length ? `还不能批：\n${s.problems.map((p, i) => `  ${i + 1}) ${p}`).join("\n")}` : "都齐了：他说「没问题」就可以批，批的是这一整包（正文 + 选定标题 + 配图 + 封面 + 创作来源）。",
    `批准状态：${approvalText(s)}`,
  ];
}
