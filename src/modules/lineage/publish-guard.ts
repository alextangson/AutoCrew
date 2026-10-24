/**
 * 派生稿发布前的唯一一道核对（Codex 审 Phase 1 P1）：源视频成片换版 / 撤批 / 文件变了之后，按旧成片做的
 * 英文版、公众号文章一律不出包、不进草稿箱、不给复制——所有发布出口都调这一个函数，不各抄一份。
 * 读不出来源状态也拒（宁可拦下问一句，不放过期稿出去）。
 * 公众号文章（Phase 2b）：还要整包批准仍有效（derivedArticlePublishRefusal）；真正推送只走「按批过的整包推草稿箱」。
 */
import { currentThemeId } from "../wechat-article/theme-id.js";
import { getContent, type Content } from "../../storage/local-store.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { staleReason } from "./lineage.js";
import { packageApprovalCheck, readArticlePackage } from "../wechat-article/package.js";
import { getArticleImageReview } from "../publish/article-images.js";
import { enPublishRefusal } from "../en-edition/package.js";
import { loadProfile } from "../profile/creator-profile.js";
import { lineStoppedReason } from "../profile/platform-lines.js";

export type DerivedRefusal = { code: "derived_stale" | "derived_source_unreadable" | "article_not_approved" | "en_package_not_approved" | "line_unpicked"; error: string };

/**
 * opts.exit = "kit"：交发布包（autocrew_pre_publish video_kit）只核源没过期——英文发布包本身要等各平台的包交齐才批得了。
 * 英文版（Phase 3 方案 (b)）的其余出口都要整个英文发布包的批准仍有效。
 */
export async function derivedPublishRefusal(content: Pick<Content, "derivedFrom"> & { id?: string }, dataDir: string, opts: { exit?: "kit" } = {}): Promise<DerivedRefusal | null> {
  if (!content.derivedFrom) return null;
  try {
    const stopped = lineStoppedReason(await loadProfile(dataDir), content.derivedFrom.kind);
    if (stopped) return { code: "line_unpicked", error: stopped };
    const reason = await staleReason(content, dataDir, { fresh: true });
    if (reason) return { code: "derived_stale", error: `这条派生稿过期了，不能发：${reason}` };
    if (content.derivedFrom.kind === "en_edition") return content.id && opts.exit !== "kit" ? await enPublishRefusal(content.id, dataDir) : null;
    return content.derivedFrom.kind === "wechat_article" && content.id ? await derivedArticlePublishRefusal(content.id, dataDir) : null;
  } catch (e) {
    return { code: "derived_source_unreadable", error: `来源状态读不出来，先不发：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 派生公众号文章的发布出口核对（Phase 2b 接上）：整包批准要还对得上现在的包（标题 / 正文 / 配图 / 封面主图与裁切 / 创作来源）。
 * 推送本身由 wechat-article/push.ts 按批过的那一包做；这里只回答「能不能发」。
 */
export async function derivedArticlePublishRefusal(contentId: string, dataDir: string): Promise<DerivedRefusal | null> {
  const content = await getContent(contentId, dataDir);
  if (!content) return null;
  const pkg = await readArticlePackage(contentId, dataDir);
  if (!pkg.approval) return { code: "article_not_approved", error: "派生公众号文章要先批整包（等你拍板里的认稿那件），再按批过的包推草稿箱" };
  const check = await packageApprovalCheck(content, pkg, await getArticleImageReview(contentId, dataDir), await currentThemeId(dataDir));
  return check.ok ? null : { code: "article_not_approved", error: `图文包的批准已失效（${check.reason}）：重新批过再发` };
}

/** 按 id 核；稿件不存在交给各出口自己报（它们有现成的「不存在」说法） */
export async function derivedPublishRefusalById(contentId: unknown, dataDir: string, opts: { exit?: "kit" } = {}): Promise<DerivedRefusal | null> {
  if (typeof contentId !== "string" || !contentId.trim()) return null;
  const content = await getContent(contentId.trim(), dataDir).catch(missingAsNull);
  return content ? derivedPublishRefusal(content, dataDir, opts) : null;
}
