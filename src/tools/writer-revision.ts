/** Compatibility for revising imported drafts that predate a writing topic/pack. */
import { CLIPBOARD_PLATFORMS } from "../modules/publish/clipboard-publisher.js";
import { loadProfile } from "../modules/profile/creator-profile.js";
import { assertClaimToken, claimGrant, ensureClaim } from "../storage/claims.js";
import { draftHash } from "../storage/draft-hash.js";
import { getContent, getTopic, saveTopic, softDeleteTopic, transitionStatus, updateContentIfDraftMatches, type Content, type ContentVersion } from "../storage/local-store.js";
import { isReadyPack, readPack, serializeWriterCall, type WritingPackFile } from "./writer-pack.js";

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
  const direct = await directRevisionAction(content, dataDir);
  if (direct) return direct;
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
    // 刚认领到的令牌接着用：同宿主不再免检，后面的复核与领包不带它就会被自己挡在门外
    const token = claimGrant(claimed, host).claim_token ?? (string(params.claim_token) || undefined);
    let createdTopic: string | undefined;
    if (!topicId) {
      const topic = await saveTopic({ title: content.title, description: "基于用户已有原稿与明确反馈修订；原稿陈述未经独立核验。", tags: [], source: REVISION_SOURCE, reason: `已有稿修订：${contentId}` }, dataDir);
      topicId = topic.id;
      createdTopic = topic.id;
    }
    if (!content.topicId || !content.platform) {
      try {
        const linked = await updateContentIfDraftMatches(contentId, content, latest => {
          const currentClaim = assertClaimToken(latest, host, token);
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
    return { ok: true, params: { ...defaults, ...params, topic_id: topicId, platform, ...(token ? { claim_token: token } : {}) } };
  });
}

// ─── 宿主直接修订（P6 §3.7）───────────────────────────────────────────────────

/** 每个写作包最多开 3 个直接修订周期；用尽回 needs_human，交创作者决定（重领包 = 创作者介入，周期随新包重计） */
export const MAX_REVISION_CYCLES = 3;

/** writing-pack.json 上直接修订用的几格。包的类型定义不在本文件，读写一律经 `cycleFields` */
interface CycleFields {
  revisionCycles?: number;
  /** 周期开了、修订说明还没落进版本记录（首轮被修复门打回时稿没落盘，说明等下一次落盘再记） */
  pendingRevision?: { cycle: number; note?: string };
}
const cycleFields = (pack: WritingPackFile) => pack as WritingPackFile & CycleFields;

export function revisionCyclesUsed(pack: WritingPackFile): number {
  return cycleFields(pack).revisionCycles ?? 0;
}

type Refusal = { ok: false; error: string } & Record<string, unknown>;

/** `revision_of` 是宿主手上那一版的指纹：对不上就是稿在别处被改过，绝不把修订套到没看过的稿上 */
export function directRevisionRefusal(content: Content, pack: WritingPackFile, revisionOf: string, opensCycle: boolean): Refusal | null {
  if (revisionOf !== draftHash(content)) {
    return {
      ok: false, code: "stale_draft",
      error: "revision_of 与当前稿不符：稿件已经变化（可能创作者在编辑器里改过）。先 autocrew_editorial inspect 读当前稿与 draft_hash，再按当前稿修订；本次未改动任何内容。",
      next_action: { tool: "autocrew_editorial", params: { action: "inspect", content_id: content.id } },
    };
  }
  if (!opensCycle || revisionCyclesUsed(pack) < MAX_REVISION_CYCLES) return null;
  return {
    ok: false, code: "revision_budget_exhausted", status: "needs_human",
    error: `本稿已用满 ${MAX_REVISION_CYCLES} 个直接修订周期，不再自动改稿；本次未改动任何内容。`,
    revision_cycles: revisionCyclesUsed(pack), max_revision_cycles: MAX_REVISION_CYCLES,
    next_action: { action: "ask_creator", message: "把当前稿和残留问题交给创作者决定。创作者给出修改意见后用 autocrew_editorial feedback 记录，再按返回的 next_action 重领写作包。" },
  };
}

/**
 * 开一个修订周期：`draft_ready → revision`（带稿件指纹，期间被改过就不推），审稿轮数归零、attempts 不清。
 * 包只在内存里改，由调用方随这一次提交的记录一起落盘。
 */
export async function openRevisionCycle(
  content: Content, pack: WritingPackFile, args: { host: string; revisionNote?: string }, dataDir: string,
): Promise<{ ok: true; content: Content } | Refusal> {
  const moved = await transitionStatus(content.id, "revision", {
    expectedStatus: "draft_ready", expectedDraft: { title: content.title, body: content.body, platform: content.platform }, host: args.host,
  }, dataDir);
  if (!moved.ok || !moved.content) {
    return moved.staleDraft
      ? { ok: false, code: "stale_draft", error: "开始修订前稿件已经变化；先 autocrew_editorial inspect 读当前稿再改。本次未改动任何内容。" }
      : { ok: false, error: `稿件没能回到修订阶段：${moved.error ?? "未推进"}` };
  }
  const fields = cycleFields(pack);
  fields.revisionCycles = revisionCyclesUsed(pack) + 1;
  pack.reviewRounds = 0;
  const note = args.revisionNote?.trim();
  fields.pendingRevision = { cycle: fields.revisionCycles, ...(note ? { note } : {}) };
  return { ok: true, content: moved.content };
}

/** 本周期第一次落盘的版本记下来源与修订说明（宿主的话，不写成用户反馈），记完即清 */
export function takeRevisionVersion(pack: WritingPackFile, host: string, attempt: number): { note: string; meta: Pick<ContentVersion, "source" | "revisionNote"> } | undefined {
  const fields = cycleFields(pack);
  const pending = fields.pendingRevision;
  if (!pending) return undefined;
  delete fields.pendingRevision;
  return {
    note: `${host} 直接修订（修订周期 ${pending.cycle}/${MAX_REVISION_CYCLES}，第 ${attempt} 次交稿）`,
    meta: { source: "host", ...(pending.note ? { revisionNote: pending.note } : {}) },
  };
}

/**
 * 草稿就绪、没有待应用的创作者意见时，改稿走 writer submit{revision_of}——不重领包、不绕 editorial。
 * 待应用的意见（本稿反馈或平台/口吻规则晚于这份包）只有重领包才进得了材料，那条路保留。
 */
async function directRevisionAction(content: Content, dataDir: string): Promise<Record<string, unknown> | null> {
  if (content.status !== "draft_ready" || !content.pack) return null;
  const issuedAt = content.pack.issuedAt;
  if ((content.writingFeedback ?? []).some((item) => item.at > issuedAt)) return null;
  if (((await loadProfile(dataDir))?.updatedAt ?? "") > issuedAt) return null;
  const pack = await readPack(content.id, dataDir);
  if (!isReadyPack(pack) || pack.packId !== content.pack.packId || revisionCyclesUsed(pack) >= MAX_REVISION_CYCLES) return null;
  const last = Math.max(0, ...Object.keys(pack.attempts).map(Number).filter(Number.isInteger));
  return {
    tool: "autocrew_writer",
    params: { action: "submit", content_id: content.id, pack_id: pack.packId, attempt: last + 1, revision_of: draftHash(content) },
    message: `直接交修订稿：带完整 title/body（可附 revision_note 说明改了什么），开第 ${revisionCyclesUsed(pack) + 1}/${MAX_REVISION_CYCLES} 个修订周期，照常过门与审稿；不重领写作包。`,
  };
}
