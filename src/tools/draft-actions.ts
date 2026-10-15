/**
 * autocrew_draft 的写稿动作：verify_quote / angle / save。prepare_final 在 draft-prepare.ts。
 * angle / save 在 withVersion 里：版本比对与写入同一把单稿写锁（锁里不能再调 updateContent / transitionStatus）。
 */
import { getContent, getTopic, saveTopic, transitionStatus, type Content, type ContentTx } from "../storage/local-store.js";
import { FirstBodyRefusedError, isRealDraft, modelWrite } from "../storage/first-body-guard.js";
import { ScriptFrozenError } from "../storage/production-store.js";
import { recordFounderAngle } from "../modules/research/angle-gate.js";
import { verifyQuote } from "../modules/draft/verify-quote.js";
import { applyLessons, type DraftFeedbackInput, type DraftFeedbackRecord, type LessonResult } from "../modules/draft/draft-feedback.js";
import { currentVersion, draftNextNote, workbenchUrl, type DraftAngle, type DraftReviewNote } from "../modules/draft/draft-types.js";
import { GENRE_HINT, pinnedPlaybook } from "../modules/playbook/read.js";
import { loadManifest, entryOf } from "../modules/playbook/store.js";
import { isPlaybookId, PLAYBOOK_IDS, type PlaybookId, type PlaybookPin } from "../modules/playbook/types.js";
import { fail, withVersion } from "./draft-version.js";
import { INVALID, normalizeChain, type DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;

export async function draftVerifyQuote(a: DraftArgs): Promise<R> {
  if (!a.contentId || !a.url || !a.quote?.trim()) return fail("bad_param", "verify_quote 要带 content_id、url 和 quote（原网页里逐字复制的一段）");
  const content = await getContent(a.contentId, a.dataDir);
  if (!content?.draftPath) return fail("not_started", "先用 start 建稿或接手，再核引文");
  return verifyQuote(content.id, a.url, a.quote, a.claim, a.dataDir);
}

async function topicFor(c: Content, tx: ContentTx, dataDir?: string) {
  const existing = c.topicId ? await getTopic(c.topicId, dataDir) : null;
  if (existing && !existing.deletedAt) return existing;
  const topic = await saveTopic({ title: c.title, description: c.title, tags: [], source: "autocrew_draft" }, dataDir);
  await tx.write({ topicId: topic.id });
  return topic;
}

function angleRefusal(a: DraftArgs, chain: string[] | null): R | null {
  const missing = [["main_line", a.mainLine], ["for_whom", a.forWhom], ["opening", a.opening], ["why_viral", a.whyViral], ["founder_words", a.founderWords], ["genre", a.genre]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return fail("bad_param", `angle 缺：${missing.join("、")}。founder_words 照抄创始人选立意时的原话（说「你定」就记「你定」）；${GENRE_HINT}`, missing.includes("genre") ? { genres: [...PLAYBOOK_IDS] } : {});
  if (!isPlaybookId(a.genre)) return fail("bad_genre", `不认识的体裁：${a.genre}。${GENRE_HINT}`, { genres: [...PLAYBOOK_IDS] });
  if (!chain || chain.length < 4 || chain.length > 6) return fail("bad_param", `chain 要 4–6 行论证链，现在是 ${chain?.length ?? 0} 行`);
  return null;
}

export async function draftAngle(a: DraftArgs): Promise<R> {
  const chain = normalizeChain(a.chain);
  const refused = angleRefusal(a, chain);
  if (refused) return refused;
  const genre = a.genre as PlaybookId;
  const latest = entryOf(await loadManifest(a.dataDir), genre).current;
  return withVersion(a, async (c, tx) => {
    const prev = c.draftPath?.angle;
    // 同一体裁重新出立意保留原来记下的版本；换了体裁（或旧立意没记版本）记当前版本（spec §9.4）
    const playbook: PlaybookPin = prev?.playbook?.id === genre ? prev.playbook : { id: genre, version: latest };
    const book = await pinnedPlaybook(playbook, a.dataDir);
    const topic = await topicFor(c, tx, a.dataDir);
    if (!await recordFounderAngle(topic, a.mainLine!, a.founderWords!, a.dataDir)) return fail("angle_failed", "立意没记上：选题记录写不进去");
    const version = (prev?.version ?? 0) + 1;
    const angle: DraftAngle = { version, main_line: a.mainLine!, for_whom: a.forWhom!, opening: a.opening!, why_viral: a.whyViral!, chain: chain!, founder_words: a.founderWords!, ...(a.chosenOption ? { chosen_option: a.chosenOption } : {}), playbook, at: new Date().toISOString() };
    await tx.write({ draftPath: { ...c.draftPath!, angle } });
    return { ok: true, angle_version: version, version: currentVersion(c), playbook: book, workbench_url: workbenchUrl(c.id),
      next_action: { note: "按选定的立意、论证链和 playbook 手册全文写全文，再 save；Codex 审稿的 {{CRAFT}} 填这本手册全文" } };
  });
}

const TRUNCATED_TAIL = /(\.\.\.|…|（未完）?|\(truncated\)|未完待续)\s*$/;
const FORMAT_MARKS: Array<[RegExp, string]> = [
  [/[[【（(]\s*停顿\s*[\]】）)]/, "有停顿标注：口播稿只交纯朗读正文"],
  [/[[【（(]\s*(?:画面|镜头|B-?roll|字幕|音效|配乐)[^\]】）)]*[\]】）)]|(?:^|\n)\s*(?:画面|镜头)[:：]/i, "有画面 / 镜头提示：口播稿不写这些"],
];

function bodyRefusal(body: string | undefined): R | null {
  const text = body?.trim() ?? "";
  if (!text) return fail("empty_body", "正文是空的，没存");
  if (text.length < 80) return fail("truncated_body", `正文只有 ${text.length} 个字，像是没写完或被截断了，没存`);
  if (TRUNCATED_TAIL.test(text)) return fail("truncated_body", "正文结尾像被截断了（省略号 / 未完），没存；如果是有意的省略号，结尾换成句号");
  return null;
}

async function writeVersion(a: DraftArgs, c: Content, tx: ContentTx): Promise<R> {
  // 正文和标题都没变就不会出新版本：带意见的重放会把原话和出处重复记一遍
  if (a.feedback && a.body === c.body && (!a.title || a.title === c.title)) return fail("no_change", "正文和标题都没变，不会出新版本，意见没记：按意见改完再带 feedback 存");
  const angle = c.draftPath?.angle;
  const provenance = modelWrite(a.host, angle ? { direction: angle.main_line } : undefined);
  let saved: Content | null;
  try {
    saved = await tx.write({ ...(a.title ? { title: a.title } : {}), body: a.body!, writtenBy: { kind: "host", host: a.host },
      // 看板交出去的稿没调 start 直接存了一版，也算接手（spec 2026-10-15 §B5）
      ...(c.writingHandoff && !c.writingHandoff.pickedUpAt ? { writingHandoff: { ...c.writingHandoff, pickedUpAt: new Date().toISOString(), pickedUpBy: a.host } } : {}),
      _versionNote: a.note ?? "AI 写入", _editor: "agent", _provenance: provenance });
  } catch (err) {
    if (err instanceof FirstBodyRefusedError) return fail("needs_angle", "还没记录创始人选定的立意：先出 3 个立意让创始人选，用 angle 记下再存稿", { detail: err.refusal.error, next_action: { tool: "autocrew_draft", params: { action: "angle", content_id: c.id } } });
    if (err instanceof ScriptFrozenError) return fail("script_frozen", err.message);
    throw err;
  }
  if (!saved) return fail("not_found", `稿件不存在：${c.id}`);
  const version = currentVersion(saved);
  let notes = saved.draftPath?.reviewNotes ?? [];
  if (a.reviewNotes !== undefined) notes = [...notes, { version, notes: a.reviewNotes as DraftReviewNote["notes"], at: new Date().toISOString() }];
  const fb = a.feedback && typeof a.feedback === "object" ? await learn(a.feedback, c.id, version, angle?.playbook, a.dataDir, c.example) : null;
  if (a.reviewNotes !== undefined || fb) {
    await tx.write({ draftPath: { ...saved.draftPath!, reviewNotes: notes, ...(fb ? { feedback: [...(saved.draftPath?.feedback ?? []), fb.record] } : {}) } });
  }
  return { ok: true, version, status: saved.status, reviewed: notes.length > 0, format_warnings: FORMAT_MARKS.filter(([re]) => re.test(a.body!)).map(([, msg]) => msg), ...(fb?.receipt ?? {}) };
}

/** 版本已存之后才记意见：档案写失败不回滚这一版，回执带原始错误（不静默） */
async function learn(input: DraftFeedbackInput, contentId: string, version: number, playbook: PlaybookPin | undefined, dataDir?: string, example?: boolean): Promise<{ record: DraftFeedbackRecord; receipt: R }> {
  const lessons: LessonResult[] = [];
  let error: string | undefined;
  try {
    // O20：示例稿的意见照记在稿上，但不进写作规则 / 手册提案
    if (!example) await applyLessons(input, contentId, version, dataDir, lessons);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const record: DraftFeedbackRecord = { version, founder_words: input.founder_words, ...(input.chosen_option ? { chosen_option: input.chosen_option } : {}), at: new Date().toISOString(), ...(playbook ? { playbook } : {}),
    lessons: lessons.map((l) => ({ ...(l.rule_id ? { rule_id: l.rule_id } : {}), ...(l.proposal_id ? { proposal_id: l.proposal_id } : {}), outcome: l.outcome })) };
  return { record, receipt: { lessons, ...(example ? { lessons_skipped: "这是示例稿：意见记在稿上，不进写作规则和手册学习" } : {}), ...(error ? { lessons_error: `这一版已存，但规则 / 手册提案没记上：${error}。如实告诉创始人` } : {}) } };
}

export async function draftSave(a: DraftArgs): Promise<R> {
  if (a.reviewNotes === INVALID) return fail("bad_param", "review_notes 解析不了：传一段文字，或一个 JSON 对象 / 数组（不超过 2 万字）");
  if (typeof a.feedback === "string") return fail("bad_param", a.feedback);
  const bad = bodyRefusal(a.body);
  if (bad) return bad;
  const r = await withVersion(a, async (c, tx) => {
    // 第一版是按立意写的，没有意见可记
    if (a.feedback && !await isRealDraft(c, a.dataDir)) return fail("bad_param", "feedback 只在已有一版正文之后收：第一版按立意写，不带 feedback");
    return writeVersion(a, c, tx);
  });
  // 已出过定稿清单的稿又改了：退回写作中（锁外推进，状态机照常校验）
  if (r.ok && r.status === "draft_ready") await transitionStatus(a.contentId!, "drafting", { host: a.host }, a.dataDir);
  if (!r.ok) return r;
  const note = draftNextNote({ id: a.contentId!, status: "drafting", needsAngle: false, hasBody: true, reviewed: r.reviewed as boolean, checklistCurrent: false });
  return { ...r, status: undefined, reviewed: undefined, workbench_url: workbenchUrl(a.contentId!), next_action: { note } };
}
