/**
 * autocrew_draft start：一句灵感建选题 + 抖音稿（写稿中），或接手已有稿；返回三份上下文与当前进度。
 */
import { getContent, getTopic, saveContent, saveTopic, transitionStatus, updateContent, type Content, type Topic } from "../storage/local-store.js";
import { isRealDraft, modelWrite } from "../storage/first-body-guard.js";
import { SCRIPT_FROZEN } from "../storage/production-store.js";
import { firsthandContext, hitsContext, profileContext, seriesContext } from "../modules/draft/draft-context.js";
import { loadChecklist } from "../modules/draft/draft-final.js";
import { loadCraftMethod } from "../modules/craft/method.js";
import { draftHash } from "../storage/draft-hash.js";
import { currentVersion, DRAFT_PLATFORM, draftNextNote, workbenchUrl } from "../modules/draft/draft-types.js";
import type { DraftArgs } from "./draft-args.js";

const FROZEN = new Set(["editing", "cover_pending", "publish_ready", "publishing"]);

export function notDouyin(platform: string | undefined): Record<string, unknown> | null {
  if (!platform || platform === DRAFT_PLATFORM) return null;
  return {
    ok: false, code: "platform_not_supported",
    error: `autocrew_draft 只做抖音口播（douyin）；${platform} 走旧流程`,
    next_action: { tool: "autocrew_workflow", params: { action: "prepare", platform } },
  };
}

/** 这篇还能不能在写稿段接手 / 写：null = 能 */
export function stageRefusal(c: Content): Record<string, unknown> | null {
  const platform = notDouyin(c.platform);
  if (platform) return platform;
  if (c.status === "published") return { ok: false, code: "published", error: "这篇已经发布，不再接手改稿" };
  if (c.status === "archived" || c.deletedAt) return { ok: false, code: "archived", error: "这篇已归档或在回收站" };
  if (FROZEN.has(c.status)) return { ok: false, code: "script_frozen", error: SCRIPT_FROZEN };
  if (c.status === "approved") return { ok: false, code: "finalized", error: "创始人已经点了「定了」，稿子在等 A-roll。要改稿请创始人先在看板把它拉回写稿段，再来接手。" };
  return null;
}

async function progressOf(c: Content, dataDir?: string): Promise<Record<string, unknown>> {
  const real = await isRealDraft(c, dataDir);
  const checklist = await loadChecklist(c.id, dataDir);
  return {
    status: c.status,
    angle: c.draftPath?.angle ? { version: c.draftPath.angle.version, main_line: c.draftPath.angle.main_line } : null,
    needs_angle: !real && !c.draftPath?.angle,
    version: currentVersion(c),
    has_body: real,
    review_notes_for: (c.draftPath?.reviewNotes ?? []).map((n) => n.version),
    final: checklist ? { prepared_for_current: checklist.draft_hash === draftHash(c), workbench: workbenchUrl(c.id) } : null,
  };
}

function newDraft(topic: Topic, host: string, dataDir?: string, inspiration?: string): Promise<Content> {
  return saveContent({
    title: topic.title, body: "", platform: DRAFT_PLATFORM, topicId: topic.id, status: "drafting", tags: [],
    draftPath: { kind: "thin", startedAt: new Date().toISOString(), ...(inspiration ? { inspiration } : {}) }, _provenance: modelWrite(host),
  }, dataDir);
}

async function createFromInspiration(inspiration: string, host: string, dataDir?: string): Promise<Content> {
  const title = Array.from(inspiration.replace(/\s+/g, " ").trim()).slice(0, 40).join("");
  const topic = await saveTopic({ title, description: inspiration.trim(), tags: [], source: "autocrew_draft" }, dataDir);
  return newDraft(topic, host, dataDir, inspiration.trim());
}

async function resume(a: DraftArgs): Promise<Content | Record<string, unknown>> {
  let content = await getContent(a.contentId!, a.dataDir);
  if (!content) return { ok: false, code: "not_found", error: `稿件不存在：${a.contentId}` };
  const stage = stageRefusal(content);
  if (stage) return stage;
  if (!content.draftPath) content = await updateContent(content.id, { draftPath: { kind: "thin", startedAt: new Date().toISOString() } }, a.dataDir) ?? content;
  // 只存了选题的稿：接手即进「写作中」，否则之后推不到「等你认稿」
  if (content.status === "topic_saved") {
    const moved = await transitionStatus(content.id, "drafting", { host: a.host }, a.dataDir);
    if (!moved.ok) return { ok: false, code: "transition_failed", error: moved.error ?? "没能推到写作中" };
    content = moved.content ?? content;
  }
  return content;
}

/** 建稿：带 topic_id 就挂到已有选题（一手材料跟着选题走），否则从灵感新建选题 */
async function create(a: DraftArgs): Promise<Content | Record<string, unknown>> {
  if (a.topicId) {
    const topic = await getTopic(a.topicId, a.dataDir);
    if (!topic || topic.deletedAt) return { ok: false, code: "topic_not_found", error: `选题不存在或已删除：${a.topicId}。不带 topic_id 就从灵感新建选题` };
    return newDraft(topic, a.host, a.dataDir, a.inspiration);
  }
  if (!a.inspiration) return { ok: false, code: "bad_param", error: "start 要带 inspiration（创始人的一句灵感原话）、topic_id（复用已有选题）或 content_id（接手已有稿）" };
  return createFromInspiration(a.inspiration, a.host, a.dataDir);
}

export async function draftStart(a: DraftArgs): Promise<Record<string, unknown>> {
  const refused = notDouyin(a.platform);
  if (refused) return refused;
  const got = a.contentId ? await resume(a) : await create(a);
  if (!("id" in got)) return got;
  const content = got as Content;
  const topic = content.topicId ? await getTopic(content.topicId, a.dataDir) : null;
  const [profile, hits, series, firsthand, progress, craft] = await Promise.all([
    profileContext(a.dataDir), hitsContext(a.dataDir), seriesContext(content, a.dataDir), firsthandContext(topic, a.dataDir, a.inspiration ?? content.draftPath?.inspiration), progressOf(content, a.dataDir), loadCraftMethod(a.dataDir),
  ]);
  return {
    ok: true, content_id: content.id, topic_id: content.topicId ?? null, resumed: Boolean(a.contentId),
    context: { profile, hits, series, firsthand, craft_method: craft.text, craft_method_note: craft.note, craft_method_error: craft.error }, progress,
    workbench_url: workbenchUrl(content.id),
    next_action: { note: draftNextNote({ id: content.id, status: content.status, needsAngle: progress.needs_angle as boolean, hasBody: progress.has_body as boolean, reviewed: (progress.review_notes_for as number[]).length > 0, checklistCurrent: Boolean((progress.final as { prepared_for_current?: boolean } | null)?.prepared_for_current) }) },
  };
}
