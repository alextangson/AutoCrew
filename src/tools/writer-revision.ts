/** Compatibility for revising imported drafts that predate a writing topic/pack. */
import { CLIPBOARD_PLATFORMS } from "../modules/publish/clipboard-publisher.js";
import { assertClaimToken, ensureClaim } from "../storage/claims.js";
import { getContent, getTopic, saveTopic, softDeleteTopic, updateContentIfDraftMatches, type Content } from "../storage/local-store.js";
import { readPack, serializeWriterCall } from "./writer-pack.js";

const REVISION_SOURCE = "draft_revision";
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** The old body is a user's unverified claim, never a completed research brief. */
export async function importedRevisionDefaults(content: Content, dataDir: string): Promise<Record<string, unknown>> {
  if (content.genRequest || content.pack || await readPack(content.id, dataDir)) return {};
  if (content.topicId && (await getTopic(content.topicId, dataDir))?.source !== REVISION_SOURCE) return {};
  return {
    direction: "保留原稿的立意与叙述范围，按本稿用户反馈修订；不擅自换成另一个选题。",
    research_mode: "provided",
    research: `【用户已有原稿：未核验 user_claim，仅作修改基底，不代表事实已证实】\n标题：${content.title}\n${content.body}`,
  };
}

export async function revisionNextAction(content: Content, dataDir: string): Promise<Record<string, unknown>> {
  return {
    tool: "autocrew_writer",
    params: {
      action: "pack", content_id: content.id, force: true,
      ...(content.topicId ? { topic_id: content.topicId } : {}),
      ...(content.platform ? { platform: content.platform } : {}),
      ...await importedRevisionDefaults(content, dataDir),
    },
    ...(!content.platform ? { required_input: "platform" } : {}),
    message: `重领同篇写作包，保留原稿与规划，应用已记录反馈。${content.platform ? "" : "原稿未记录平台，请按用户需求补入 platform。"}原稿中的事实仍待核验；未自动改稿或批准发布。`,
  };
}

type Prepared = { ok: true; params: Record<string, unknown> } | ({ ok: false; error: string } & Record<string, unknown>);

/** Only the association step holds the writer lock; startPack takes it itself. */
export async function prepareExistingRevision(params: Record<string, unknown>, host: string, dataDir: string): Promise<Prepared> {
  const contentId = string(params.content_id);
  return serializeWriterCall(contentId, async () => {
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, error: `稿件不存在：${contentId}` };
    const platform = string(params.platform) || content.platform || "";
    if (!platform) return { ok: false, code: "needs_platform", error: "原稿未记录 platform，请按用户需求补充目标平台后重试；原稿未改动。", next_action: await revisionNextAction(content, dataDir) };
    if (!(CLIPBOARD_PLATFORMS as readonly string[]).includes(platform)) return { ok: false, error: `无效 platform「${platform}」。有效值：${CLIPBOARD_PLATFORMS.join(" | ")}` };
    if (content.platform && content.platform !== platform) return { ok: false, error: "content_id 必须属于本次 platform，不能把旧稿重领为另一平台。" };
    if (!["drafting", "revision", "draft_ready"].includes(content.status)) return { ok: false, error: `本稿现在是 ${content.status}，不能重开写作包；请先回到可修改阶段。` };
    if ((content.status === "draft_ready" || content.pack?.submittedAt) && params.force !== true) return { ok: false, code: "pack_request_changed", error: "修改已交草稿需显式带 content_id 和 force:true；新稿提交前保留正文。" };
    const claim = assertClaimToken(content, host, string(params.claim_token) || undefined);
    if (!claim.ok) return claim;
    const requestedTopic = string(params.topic_id);
    if (content.topicId && requestedTopic && content.topicId !== requestedTopic) return { ok: false, error: "content_id 必须属于本次 topic_id，已有选题关联不能换成另一选题。" };
    let topicId = content.topicId || requestedTopic;
    if (topicId && !await getTopic(topicId, dataDir)) return { ok: false, error: `选题不存在：${topicId}` };
    const defaults = await importedRevisionDefaults(content, dataDir);
    const claimed = await ensureClaim(contentId, { host, employee: "writer", token: string(params.claim_token) || undefined }, dataDir);
    if (!claimed.ok) return claimed;
    let createdTopic: string | undefined;
    if (!topicId) {
      const topic = await saveTopic({ title: content.title, description: "基于用户已有原稿与明确反馈修订；原稿陈述未经独立核验。", tags: [], source: REVISION_SOURCE, reason: `已有稿修订：${contentId}` }, dataDir);
      topicId = topic.id;
      createdTopic = topic.id;
    }
    if (!content.topicId || !content.platform) {
      try {
        const linked = await updateContentIfDraftMatches(contentId, content, latest => {
          const currentClaim = assertClaimToken(latest, host, string(params.claim_token) || undefined);
          if (!currentClaim.ok) throw new Error(currentClaim.error);
          if (!["drafting", "revision", "draft_ready"].includes(latest.status) || (latest.topicId && latest.topicId !== topicId)) throw new Error("稿件状态或关联已变化，请重新读取后修订；未覆盖新状态。");
          if ((latest.status === "draft_ready" || latest.pack?.submittedAt) && params.force !== true) throw new Error("稿件已交稿，修改需显式 force:true；未重开写作包。");
          return { topicId, platform };
        }, dataDir);
        if (!linked.ok) throw new Error("原稿已变化，请重新读取后修订；未覆盖新正文。");
      } catch (err) {
        if (createdTopic) await softDeleteTopic(createdTopic, dataDir);
        throw err;
      }
    }
    return { ok: true, params: { ...defaults, ...params, topic_id: topicId, platform } };
  });
}
