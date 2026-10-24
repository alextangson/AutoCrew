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
import { createCreativeTask } from "../writing/creative-task.js";
import type { WritingReadiness } from "../../tools/writing-readiness.js";
import type { ArticleSource } from "./source.js";
import { getTopic } from "../../storage/local-store.js";
import { resolveEffectiveBrief } from "../research/brief-snapshot.js";
import { activeAngleCard, angleCardHash } from "../research/angle-cards.js";
import { topicHashOf } from "../research/research-job-store.js";

export type DerivedRequest = { ok: true; req: ScriptRequest; sourceNote: string; researchNote: string; sourceLedger: ArticleSource["ledger"] } | { ok: false; code: string; error: string };

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
    // 同一次读源的快照：写进 requirements 的台账和并进包账的条目必须是同一份
    sourceLedger: src.source.ledger,
    researchNote: src.source.ledger.length
      ? `复用源视频的调研台账（${src.source.ledger.length} 条，只读）；不为文章另开调研任务。`
      : NO_RESEARCH_NOTE,
    req: { ...req, sourceOnlyResearch: true, packId: WECHAT_VIDEO_ARTICLE_PACK.id, requirements: [own, renderArticleSource(src.source)].filter(Boolean).join("\n\n") },
  };
}

export const NO_RESEARCH_NOTE = "源视频没有调研台账：这篇文章只靠底稿写；要补材料走 autocrew_scout，新引文先 verify_quote，记进本文自己的证据台账，不动源视频的调研任务。";

/**
 * 派生文章的写前准备（2026-10-24 创始人定）：直接复用源视频的调研台账，不开新调研任务、不替换选题上的调研任务，
 * 也不重新选立意（立意跟源视频走）。补新材料走 verify_quote → 本文自己的证据台账（同英文版）。
 */
export async function derivedArticleReadiness(topicId: string, req: ScriptRequest, researchNote: string, dataDir: string): Promise<WritingReadiness> {
  const continuation = { topic_id: topicId, platform: req.platform, ...(req.requirements !== undefined ? { requirements: stripSourceBlock(req.requirements) } : {}) };
  return {
    ready: true,
    status: "ready_to_write",
    topicId,
    creativeTask: createCreativeTask(req),
    research: { mode: "provided", status: "provided", autoResearched: false, reason: researchNote },
    angle: await sourceAngle(topicId, req, dataDir),
    note: `${researchNote}由当前宿主领取写作包，按底稿改写成长文；后台不会自动代写。`,
    next_action: { tool: "autocrew_writer", params: { ...continuation, action: "pack" } },
    continue_params: continuation,
  };
}

/** 源视频（同选题）生效的立意卡：与 buildWritingContext 的 sourceOnlyResearch 分支同一套判法，备料收尾按哈希核对 */
async function sourceAngle(topicId: string, req: ScriptRequest, dataDir: string): Promise<WritingReadiness["angle"]> {
  const skipped = { status: "skipped" as const, cards: [], reason: "由视频派生的文章沿用源视频的立意" };
  if (req.direction?.trim()) return { ...skipped, status: "direction" as const };
  const topic = await getTopic(topicId, dataDir);
  const snap = topic?.selectedAngle ? await resolveEffectiveBrief(topicId, dataDir) : null;
  const card = topic && snap ? activeAngleCard(topic.selectedAngle, snap.brief, topicHashOf(topic.title, topic.description)) : null;
  return card ? { status: "selected", cards: [], selectedAngleId: card.id, selectedAngleHash: angleCardHash(card) } : skipped;
}
