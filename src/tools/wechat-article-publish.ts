/**
 * `autocrew_content {action:"wechat_article", article:{op, …}}` 的发布段（Phase 2b）：
 * push_draft / begin_editor / mark_editor_done / record_scheduled / record_unknown / record_absent / publish_status。
 * 参数按 AGENTS.md 归一：布尔可以是 "true"/"false" 字符串，时间是字符串；各动作自己加锁，不套在通用改包锁里。
 */
import type { FoundDraft } from "../modules/wechat-article/publish-state.js";
import { pushApprovedArticle, type PushDeps } from "../modules/wechat-article/push.js";
import { beginEditor, finalCheck, markEditorDone, publishStatus, recordAbsent, recordScheduled, recordUnknown } from "../modules/wechat-article/editor-flow.js";

type Result = Record<string, unknown>;

export const PUBLISH_OPS = ["push_draft", "begin_editor", "final_check", "mark_editor_done", "record_scheduled", "record_unknown", "record_absent", "publish_status"] as const;
export type PublishOp = (typeof PUBLISH_OPS)[number];

export const WECHAT_ARTICLE_PUBLISH_DOC =
  "；发布（批过整包之后，按 publish-content 的公众号手册）：push_draft（只推批过的那一包，同一包重复调不会多推）/ begin_editor{slot?,founder_quote?}（核视频号原片已公开、排定时）/ final_check{channels_card_visible}（点「发表」前必调：先在编辑器视频号选择框里看到原片还列着，带 channels_card_visible:true；过了才点）/ mark_editor_done{scheduled_for}（点了发表、停在二维码）/ record_scheduled{scheduled_at,founder_quote,published?,media_id?|draft_title+draft_updated_at} / record_unknown{raw} / record_absent{raw,found_draft?,media_id?|draft_title+draft_updated_at}；push_draft{dry_run?} 预演不调公众号 / publish_status";

const s = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^"+|"+$/g, "").trim() : "");
const bool = (v: unknown) => v === true || (typeof v === "string" && /^(true|1|yes)$/i.test(v.trim()));
const words = (p: Result) => s(p.founder_quote ?? p.founder_words);

/** 宿主在编辑器里核到的草稿身份；空的字段不带 */
function draftOf(p: Result): FoundDraft {
  const out: FoundDraft = {};
  if (s(p.media_id)) out.mediaId = s(p.media_id);
  if (s(p.draft_title)) out.title = s(p.draft_title);
  if (s(p.draft_updated_at)) out.updatedAt = s(p.draft_updated_at);
  return out;
}

export function isPublishOp(op: string): op is PublishOp {
  return (PUBLISH_OPS as readonly string[]).includes(op);
}

export function runPublishOp(op: PublishOp, id: string, p: Result, dataDir: string, deps: PushDeps = {}): Promise<Result> {
  switch (op) {
    case "push_draft": return pushApprovedArticle(id, dataDir, deps, { force: bool(p.force), dryRun: bool(p.dry_run) });
    case "begin_editor": return beginEditor(id, dataDir, { slot: s(p.slot) || undefined, founderWords: words(p) || undefined }, deps.now);
    case "mark_editor_done": return markEditorDone(id, dataDir, { scheduledFor: s(p.scheduled_for ?? p.scheduled_at) }, deps.now);
    case "final_check": return finalCheck(id, dataDir, deps.now, { channelsCardVisible: bool(p.channels_card_visible) });
    case "record_scheduled": return recordScheduled(id, dataDir, { scheduledAt: s(p.scheduled_at), founderWords: words(p), published: bool(p.published), draft: draftOf(p) }, deps.now);
    case "record_unknown": return recordUnknown(id, dataDir, s(p.raw), deps.now);
    case "record_absent": return recordAbsent(id, dataDir, { raw: s(p.raw), foundDraft: bool(p.found_draft), draft: draftOf(p) }, deps.now);
    case "publish_status": return publishStatus(id, dataDir);
  }
}
