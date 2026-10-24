/**
 * 草稿推上去之后的编辑器收尾（Phase 2b，网页操作由宿主按 publish-content 的公众号手册用 ego-lite 做）：
 * 这里只管状态——什么时候能进编辑器、排哪个时间、走到哪一步、创始人扫没扫码、结果不明时先核对。
 * 这里没有任何一步会点「发表」或扫码；那两下是宿主（点发表）和创始人（扫码）在网页上做的。
 */
import { getContent } from "../../storage/local-store.js";
import { withArticleLock } from "./package.js";
import { approvedArticle } from "./push.js";
import { nextStep, readPublishState, withAttempt, writePublishState, type ArticlePublishState, type FoundDraft, type PublishPhase } from "./publish-state.js";
import { hostSlot, isoLocal, localDate, occupiedDays, parseShanghai, planSlot, videoChannelState, windowError } from "./slot.js";
import { edgeParagraphs } from "./push-stage.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });
const nowOf = (now?: () => Date) => (now ? now() : new Date());

async function save(id: string, st: ArticlePublishState, action: string, dataDir: string, now: Date, raw?: string): Promise<Result> {
  const next = withAttempt(st, { action, ok: true, ...(raw ? { raw } : {}) }, now);
  await writePublishState(id, next, dataDir);
  return { ok: true, phase: next.phase, media_id: next.mediaId ?? null, slot: next.slot ?? null, next_step: nextStep(next) };
}

function wrongPhase(st: ArticlePublishState, allowed: PublishPhase[], action: string): Result | null {
  if (st.phase && allowed.includes(st.phase)) return null;
  return fail(st.phase === "unknown" ? "reconcile_first" : "wrong_phase", `${action} 只能在 ${allowed.join(" / ")} 时做（现在：${st.phase ?? "还没推草稿"}）。${nextStep(st)}`, { phase: st.phase ?? null });
}

/** 进编辑器之前：包仍是推上去的那一包；视频号原片已公开；排好定时（默认按视频号时间，或创始人原话给的 slot） */
export function beginEditor(id: string, dataDir: string, input: { slot?: string; founderWords?: string }, now?: () => Date): Promise<Result> {
  return withArticleLock(id, async () => {
    const st = await readPublishState(id, dataDir);
    const bad = wrongPhase(st, ["pushed_draft", "waiting_video_live", "editor_finishing"], "begin_editor");
    if (bad) return bad;
    const a = await approvedArticle(id, dataDir);
    if ("refusal" in a) return a.refusal;
    const s = a.state;
    if (s.hash !== st.packageHash) return fail("draft_superseded", `草稿箱里那份（${st.mediaId}）是旧版图文包，现在批的是新的一包：先 push_draft 推新包（旧草稿会标为作废），别在旧草稿上收尾`);
    const t = nowOf(now);
    const video = await videoChannelState(s.content.derivedFrom!.contentId, dataDir, t.getTime());
    if (!video.live) {
      const r = await save(id, { ...st, phase: "waiting_video_live" }, "begin_editor", dataDir, t, video.raw);
      return { ...r, ok: false, code: "video_not_live", error: `视频号原片还没公开（${video.raw}）：视频号卡片只能插已公开的视频，先不进编辑器、不排定时`, video: video.raw };
    }
    const slot = await chooseSlot(id, dataDir, video.at, input, t.getTime());
    if ("error" in slot) return fail(slot.code, slot.error, { video: video.raw });
    const r = await save(id, { ...st, phase: "editor_finishing", slot }, "begin_editor", dataDir, t);
    return { ...r, creation_source: s.pkg.creationSource!.value, title: s.pkg.chosenTitle, video: video.raw, slot_basis: slot.basis, draft_identity: draftIdentity(st, s.content.body ?? ""), manual: "skills/publish-content/references/wechat-mp.md" };
  });
}

/** 编辑器里认草稿用（Codex 审 2b P1-6）：media_id、推送时刻（= 草稿箱里的更新时间）、标题、正文首末段 */
function draftIdentity(st: ArticlePublishState, body: string): Result {
  const edges = edgeParagraphs(body);
  return { media_id: st.mediaId ?? st.foundDraft?.mediaId ?? null, updated_at: st.pushedAt ? isoLocal(Date.parse(st.pushedAt)) : st.foundDraft?.updatedAt ?? null, title: st.foundDraft?.title ?? null, first_paragraph: edges.first, last_paragraph: edges.last };
}

/** 点发表前（final_check）和点完后（mark_editor_done）共用：批准有效、源没过期、草稿就是批过的那一包、定时那天还空着且在窗口内 */
async function stillPublishable(id: string, st: ArticlePublishState, dataDir: string, now: number): Promise<Result | null> {
  const a = await approvedArticle(id, dataDir);
  if ("refusal" in a) return a.refusal;
  if (a.state.hash !== st.packageHash) return fail("draft_superseded", "草稿箱里那份不是现在批的这一包：不要点发表，先 push_draft 推新包");
  const at = Date.parse(st.slot!.at);
  const w = windowError(at, now);
  if (w) return fail("invalid_slot", `${w}：不要点发表，重新 begin_editor 排时间`);
  if ((await occupiedDays(id, dataDir)).has(localDate(at))) return fail("slot_taken", `${localDate(at)} 的群发通知已经被别的文章占了：不要点发表，重新 begin_editor 排时间`);
  return null;
}

/** 点「发表」之前最后一道核对：过了才能点（手册规定），不过就停 */
export function finalCheck(id: string, dataDir: string, now?: () => Date): Promise<Result> {
  return withArticleLock(id, async () => {
    const st = await readPublishState(id, dataDir);
    const bad = wrongPhase(st, ["editor_finishing"], "final_check");
    if (bad) return bad;
    const t = nowOf(now);
    const refused = await stillPublishable(id, st, dataDir, t.getTime());
    if (refused) return { ...refused, may_click_publish: false };
    // 视频号原片在 begin_editor 之后可能被删 / 设成私密：点发表前再核一次（卡片插的就是它）
    const video = await videoChannelState((await getContent(id, dataDir))!.derivedFrom!.contentId, dataDir, t.getTime());
    if (!video.live) return fail("video_not_live", `视频号原片现在不是公开状态（${video.raw}）：不要点发表，先确认原片还在、已公开，再重新 begin_editor`, { may_click_publish: false, video: video.raw });
    const r = await save(id, st, "final_check", dataDir, t);
    return { ...r, may_click_publish: true, slot: st.slot, note: "可以点一次「发表」，停在管理员二维码后 mark_editor_done" };
  });
}

async function chooseSlot(id: string, dataDir: string, videoAt: number | null, input: { slot?: string; founderWords?: string }, now: number) {
  const occupied = await occupiedDays(id, dataDir);
  if (input.slot) {
    if (!input.founderWords) return { code: "founder_words_required", error: "自己给定时时间要带创始人的原话（founder_quote）" };
    const r = hostSlot(input.slot, input.founderWords, now, occupied);
    return "error" in r ? { code: "invalid_slot", error: r.error } : r;
  }
  if (videoAt === null) return { code: "slot_required", error: "视频号已公开但读不到它的发布时间，排不出默认时间：请创始人定一个时间，带 slot + founder_quote 再 begin_editor" };
  const r = planSlot(videoAt, now, occupied);
  return "error" in r ? { code: "invalid_slot", error: r.error } : r;
}

/** 宿主在编辑器里做完：创作来源、视频号卡片、定时（就是排好的那个时间）、点了发表、停在管理员二维码 */
export function markEditorDone(id: string, dataDir: string, input: { scheduledFor: string }, now?: () => Date): Promise<Result> {
  return withArticleLock(id, async () => {
    const st = await readPublishState(id, dataDir);
    const bad = wrongPhase(st, ["editor_finishing"], "mark_editor_done");
    if (bad) return bad;
    const t = parseShanghai(input.scheduledFor);
    if (t === null || isoLocal(t) !== st.slot!.at) return fail("slot_mismatch", `编辑器里填的定时要和排好的一致：${st.slot!.at}（收到 ${input.scheduledFor || "空"}）。改了时间就重新 begin_editor 带 slot + 创始人原话`);
    const at = nowOf(now);
    const refused = await stillPublishable(id, st, dataDir, at.getTime());
    if (refused) {
      // 发表已经点了但核对不过：二维码之前什么都没定，先停下去 定时列表 看，必要时请创始人取消
      const raw = `点发表之后复核不过：${String(refused.error)}`;
      await save(id, { ...st, phase: "unknown", unknownFrom: "editor_finishing", unknownRaw: raw }, "mark_editor_done", dataDir, at, raw);
      return { ...refused, phase: "unknown", error: `${String(refused.error)}。已经点过发表的话先别扫码：去 定时列表 核对，必要时请创始人取消，再 record_absent / record_scheduled` };
    }
    const r = await save(id, { ...st, phase: "scheduled_waiting_scan" }, "mark_editor_done", dataDir, at);
    return { ...r, hand_off: "停在管理员二维码：用 task.handOff() 交给创始人扫码；他说扫了之后去 发表记录 / 定时列表 核到这篇，再 record_scheduled" };
  });
}

/** 创始人扫码后、宿主在 发表记录 / 定时列表 里核到了：记回执（时间 + 创始人原话） */
export interface ScheduledInput { scheduledAt: string; founderWords: string; published: boolean; draft: FoundDraft }

export function recordScheduled(id: string, dataDir: string, input: ScheduledInput, now?: () => Date): Promise<Result> {
  return withArticleLock(id, async () => {
    const st = await readPublishState(id, dataDir);
    const bad = wrongPhase(st, ["scheduled_waiting_scan", "unknown", "scheduled"], "record_scheduled");
    if (bad) return bad;
    if (st.phase === "scheduled" && !input.published) return fail("wrong_phase", "已经记过定时了；到点发出后带 published:true 再记一次");
    const known = st.mediaId ?? st.foundDraft?.mediaId;
    const found = input.draft.mediaId || (input.draft.title && input.draft.updatedAt) ? input.draft : null;
    if (st.phase === "unknown" && !known && !found) return fail("draft_identity_required", "结果不明时记回执要带核到的草稿身份：media_id（看得到的话），或 draft_title + draft_updated_at（定时列表 / 发表记录里这篇的标题和更新时间）");
    if (!input.founderWords) return fail("founder_words_required", "记定时回执要创始人的原话（他说扫了 / 看到了的那句，founder_quote 照抄）");
    const when = parseShanghai(input.scheduledAt);
    if (when === null) return fail("invalid_params", "scheduled_at 要是时间：照 定时列表 / 发表记录 里看到的写（不带时区按北京时间）");
    const t = nowOf(now);
    const receipt = { scheduledAt: isoLocal(when), founderWords: input.founderWords, published: input.published, at: t.toISOString() };
    const phase: PublishPhase = input.published ? "published" : "scheduled";
    const r = await save(id, { ...st, phase, receipt, ...(found ? { foundDraft: found } : {}), unknownFrom: undefined, unknownRaw: undefined }, "record_scheduled", dataDir, t);
    const drift = st.slot && st.slot.at !== receipt.scheduledAt ? { warning: `核到的时间 ${receipt.scheduledAt} 和排好的 ${st.slot.at} 不一样，已按核到的记` } : {};
    return { ...r, receipt, ...drift };
  });
}

/** 任何一步结果不明（扫码后页面没回、点了发表没反应）：记原话，之后只能先核对 */
export function recordUnknown(id: string, dataDir: string, raw: string, now?: () => Date): Promise<Result> {
  return withArticleLock(id, async () => {
    const st = await readPublishState(id, dataDir);
    if (!raw) return fail("invalid_params", "record_unknown 要 raw：照实写看到了什么（页面、报错、没回应）");
    if (!st.phase || st.phase === "published") return fail("wrong_phase", `现在是 ${st.phase ?? "还没推草稿"}，没有可以不明的一步`);
    const from = st.phase === "unknown" ? st.unknownFrom : st.phase;
    return save(id, { ...st, phase: "unknown", unknownFrom: from, unknownRaw: raw }, "record_unknown", dataDir, nowOf(now), raw);
  });
}

/** 核对过了，定时列表 / 发表记录里没有这篇（或创始人在后台取消了定时）：回到可以继续的那一步 */
export function recordAbsent(id: string, dataDir: string, input: { raw: string; foundDraft: boolean; draft: FoundDraft }, now?: () => Date): Promise<Result> {
  return withArticleLock(id, async () => {
    const st = await readPublishState(id, dataDir);
    const bad = wrongPhase(st, ["unknown", "scheduled_waiting_scan", "scheduled"], "record_absent");
    if (bad) return bad;
    if (!input.raw) return fail("invalid_params", "record_absent 要 raw：在哪几处核过、看到了什么");
    // 草稿也确认不在了 → 清掉草稿身份，之后 push_draft 会真推一份（Codex 审 2b P2-8）
    if (!input.foundDraft) {
      return save(id, { ...st, phase: "failed", mediaId: undefined, packageHash: undefined, pushedAt: undefined, foundDraft: undefined, slot: undefined, receipt: undefined, unknownFrom: undefined, unknownRaw: undefined }, "record_absent", dataDir, nowOf(now), input.raw);
    }
    const foundDraft = st.mediaId ? st.foundDraft : { ...input.draft, mediaId: input.draft.mediaId || st.foundDraft?.mediaId };
    if (!st.mediaId && !foundDraft?.mediaId && !(foundDraft?.title && foundDraft.updatedAt)) return fail("draft_identity_required", "草稿箱里核到了就带上它的身份：media_id，或 draft_title + draft_updated_at");
    return save(id, { ...st, phase: "pushed_draft", foundDraft, slot: undefined, receipt: undefined, unknownFrom: undefined, unknownRaw: undefined }, "record_absent", dataDir, nowOf(now), input.raw);
  });
}

/** 发布状态全貌：阶段、草稿、排期、回执、作废的旧草稿、最近几次尝试；草稿是不是旧包 */
export async function publishStatus(id: string, dataDir: string): Promise<Result> {
  const st = await readPublishState(id, dataDir);
  const a = await approvedArticle(id, dataDir);
  const current = "state" in a ? a.state.hash : null;
  const content = await getContent(id, dataDir);
  return {
    ok: true, content_id: id, title: content?.title ?? null, phase: st.phase ?? "not_pushed", account: st.account ?? null, media_id: st.mediaId ?? null,
    slot: st.slot ?? null, receipt: st.receipt ?? null, found_draft: st.foundDraft ?? null, in_flight: st.inFlight ?? null, unknown_raw: st.unknownRaw ?? null, superseded: st.superseded,
    draft_is_current_package: st.packageHash ? st.packageHash === current : null,
    draft_identity: st.packageHash ? draftIdentity(st, content?.body ?? "") : null,
    ...("refusal" in a ? { publish_blocked: a.refusal.error } : {}),
    attempts: st.attempts.slice(-5), next_step: nextStep(st),
  };
}
