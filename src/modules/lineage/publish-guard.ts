/**
 * 派生稿发布前的唯一一道核对（Codex 审 Phase 1 P1）：源视频成片换版 / 撤批 / 文件变了之后，按旧成片做的
 * 英文版、公众号文章一律不出包、不进草稿箱、不给复制——所有发布出口都调这一个函数，不各抄一份。
 * 读不出来源状态也拒（宁可拦下问一句，不放过期稿出去）。
 * 公众号文章（Phase 2a）：不过期也一律拒，等 2b 接上按整包发布（derivedArticlePublishRefusal）。
 */
import { getContent, type Content } from "../../storage/local-store.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { staleReason } from "./lineage.js";

export type DerivedRefusal = { code: "derived_stale" | "derived_source_unreadable" | "derived_article_publish_pending"; error: string };

export async function derivedPublishRefusal(content: Pick<Content, "derivedFrom"> & { id?: string }, dataDir: string): Promise<DerivedRefusal | null> {
  if (!content.derivedFrom) return null;
  try {
    const reason = await staleReason(content, dataDir, { fresh: true });
    if (reason) return { code: "derived_stale", error: `这条派生稿过期了，不能发：${reason}` };
    return content.derivedFrom.kind === "wechat_article" && content.id ? await derivedArticlePublishRefusal(content.id, dataDir) : null;
  } catch (e) {
    return { code: "derived_source_unreadable", error: `来源状态读不出来，先不发：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 派生公众号文章的发布出口（唯一的钩子，Phase 2b 换成「按批过的整包推草稿箱」）。
 * 现有出口用的是稿件标题和旧封面审核，会丢掉选定标题、封面一对和 web 图署名——所以 2a 一律拒。
 */
export async function derivedArticlePublishRefusal(_contentId: string, _dataDir: string): Promise<DerivedRefusal | null> {
  return { code: "derived_article_publish_pending", error: "派生公众号文章要按批过的图文包发布，这一步还没接上（Phase 2b）：现在的发布出口会用错标题和封面，先不发" };
}

/** 按 id 核；稿件不存在交给各出口自己报（它们有现成的「不存在」说法） */
export async function derivedPublishRefusalById(contentId: unknown, dataDir: string): Promise<DerivedRefusal | null> {
  if (typeof contentId !== "string" || !contentId.trim()) return null;
  const content = await getContent(contentId.trim(), dataDir).catch(missingAsNull);
  return content ? derivedPublishRefusal(content, dataDir) : null;
}
