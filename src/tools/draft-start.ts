/**
 * autocrew_draft start：一句灵感建选题 + 抖音稿（写稿中），或接手已有稿；返回三份上下文与当前进度。
 */
import { getContent, getTopic, saveContent, saveTopic, updateContent, type Content } from "../storage/local-store.js";
import { isRealDraft, modelWrite } from "../storage/first-body-guard.js";
import { SCRIPT_FROZEN } from "../storage/production-store.js";
import { firsthandContext, hitsContext, profileContext, seriesContext } from "../modules/draft/draft-context.js";
import { reviewView } from "../modules/draft/codex-review-queue.js";
import { loadChecklist } from "../modules/draft/draft-final.js";
import { draftHash } from "../storage/draft-hash.js";
import { DRAFT_PLATFORM, workbenchUrl } from "../modules/draft/draft-types.js";
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
    versions: real ? c.versions?.length ?? 0 : 0,
    review: await reviewView(c.id, dataDir),
    final: checklist ? { prepared_for_current: checklist.draft_hash === draftHash(c), workbench: workbenchUrl(c.id) } : null,
  };
}

async function createFromInspiration(inspiration: string, host: string, dataDir?: string): Promise<Content> {
  const title = Array.from(inspiration.replace(/\s+/g, " ").trim()).slice(0, 40).join("");
  const topic = await saveTopic({ title, description: inspiration.trim(), tags: [], source: "autocrew_draft" }, dataDir);
  return saveContent({
    title, body: "", platform: DRAFT_PLATFORM, topicId: topic.id, status: "drafting", tags: [],
    draftPath: { kind: "thin", startedAt: new Date().toISOString() }, _provenance: modelWrite(host),
  }, dataDir);
}

export async function draftStart(a: DraftArgs): Promise<Record<string, unknown>> {
  const refused = notDouyin(a.platform);
  if (refused) return refused;
  let content: Content | null;
  if (a.contentId) {
    content = await getContent(a.contentId, a.dataDir);
    if (!content) return { ok: false, code: "not_found", error: `稿件不存在：${a.contentId}` };
    const stage = stageRefusal(content);
    if (stage) return stage;
    if (!content.draftPath) content = await updateContent(content.id, { draftPath: { kind: "thin", startedAt: new Date().toISOString() } }, a.dataDir) ?? content;
  } else {
    if (!a.inspiration) return { ok: false, code: "bad_param", error: "start 要带 inspiration（创始人的一句灵感原话）或 content_id（接手已有稿）" };
    content = await createFromInspiration(a.inspiration, a.host, a.dataDir);
  }
  const topic = content.topicId ? await getTopic(content.topicId, a.dataDir) : null;
  const [profile, hits, series, firsthand, progress] = await Promise.all([
    profileContext(a.dataDir), hitsContext(a.dataDir), seriesContext(content, a.dataDir), firsthandContext(topic, a.dataDir), progressOf(content, a.dataDir),
  ]);
  return {
    ok: true, content_id: content.id, topic_id: content.topicId ?? null, resumed: Boolean(a.contentId),
    context: { profile, hits, series, firsthand }, progress,
    next_action: { note: progress.needs_angle ? "按 write-script 技能走：衍生 → 调研（read / cite）→ 立意（angle）→ 写（save）" : "接着上次的进度做；改主线先回到立意（angle）" },
  };
}
