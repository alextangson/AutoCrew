/**
 * 派生公众号文章领写作包时的改写（Phase 2a）：固定用「公众号长文（由视频改写）」赛道包，
 * 把底稿（成片字幕 / 退回定稿正文的说明）和源视频台账接在写作要求后面。底稿说明同时记进发布包，审阅页照显示。
 * 重领包时先去掉上一次接的底稿块，不叠两份。
 */
import type { Content } from "../../storage/local-store.js";
import type { ScriptRequest } from "../writing/script-prompt.js";
import { WECHAT_VIDEO_ARTICLE_PACK } from "../packs/wechat-video-article.js";
import { articleSource, renderArticleSource, SOURCE_BLOCK_HEAD } from "./source.js";
import { readArticlePackage, writeArticlePackage } from "./package.js";

export type DerivedRequest = { ok: true; req: ScriptRequest; sourceNote: string } | { ok: false; code: string; error: string };

export function stripSourceBlock(requirements: string | undefined): string {
  const text = requirements ?? "";
  const at = text.indexOf(SOURCE_BLOCK_HEAD);
  return (at >= 0 ? text.slice(0, at) : text).trim();
}

export async function derivedArticleRequest(content: Content, req: ScriptRequest, dataDir: string): Promise<DerivedRequest | null> {
  if (content.derivedFrom?.kind !== "wechat_article") return null;
  const src = await articleSource(content, dataDir);
  if (!src.ok) return src;
  const own = stripSourceBlock(req.requirements);
  const pkg = await readArticlePackage(content.id, dataDir);
  if (pkg.sourceNote !== src.source.note) await writeArticlePackage(content.id, { ...pkg, sourceNote: src.source.note }, dataDir);
  return {
    ok: true,
    sourceNote: src.source.note,
    req: { ...req, packId: WECHAT_VIDEO_ARTICLE_PACK.id, requirements: [own, renderArticleSource(src.source)].filter(Boolean).join("\n\n") },
  };
}
