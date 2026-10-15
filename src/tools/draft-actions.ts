/**
 * autocrew_draft 的写稿动作：verify_quote / save。angle 在 draft-angle.ts，opening 在 draft-opening.ts，prepare_final 在 draft-prepare.ts。
 * save 在 withVersion 里：版本比对与写入同一把单稿写锁（锁里不能再调 updateContent / transitionStatus）。
 *
 * 改稿意见（spec 2026-10-15 §6、§15.6、§15.7）：这条路上 save 不再即时生成档案规则或手册提案。
 * 原话照存在稿上（正文没改也能记）；旧会话照传的 lessons 原样留着，回执写明「已改为定稿时跨稿比对」。
 */
import { getContent, transitionStatus, type Content, type ContentTx } from "../storage/local-store.js";
import { FirstBodyRefusedError, isRealDraft, modelWrite } from "../storage/first-body-guard.js";
import { ScriptFrozenError } from "../storage/production-store.js";
import { verifyQuote } from "../modules/draft/verify-quote.js";
import type { DraftFeedbackInput, DraftFeedbackRecord } from "../modules/draft/draft-feedback.js";
import { bodyHash, currentVersion, draftNextNote, needsOpening, workbenchUrl, type DraftReviewNote, type TestReadRecord } from "../modules/draft/draft-types.js";
import type { TestReadInput } from "../modules/draft/draft-args-extra.js";
import { fail, withVersion } from "./draft-version.js";
import { INVALID, type DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;
export const LESSONS_DEFERRED = "这条已改为定稿时跨稿比对：lessons 原样记在这篇的意见里，不再即时生成规则或手册提案";

export async function draftVerifyQuote(a: DraftArgs): Promise<R> {
  if (!a.contentId || !a.url || !a.quote?.trim()) return fail("bad_param", "verify_quote 要带 content_id、url 和 quote（原网页里逐字复制的一段）");
  const content = await getContent(a.contentId, a.dataDir);
  if (!content?.draftPath) return fail("not_started", "先用 start 建稿或接手，再核引文");
  return verifyQuote(content.id, a.url, a.quote, a.claim, a.dataDir);
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

function feedbackRecord(input: DraftFeedbackInput, version: number, c: Content, bodyChanged: boolean): DraftFeedbackRecord {
  const playbook = c.draftPath?.angle?.playbook;
  return { version, founder_words: input.founder_words, ...(input.chosen_option ? { chosen_option: input.chosen_option } : {}), at: new Date().toISOString(), stage: "body", body_changed: bodyChanged, lessons: [],
    ...(playbook ? { playbook } : {}), ...(input.lessons.length ? { deferred_lessons: input.lessons } : {}) };
}

function testReadRecord(t: TestReadInput, version: number, body: string): TestReadRecord {
  return { kind: "viewer_test_read", version, status: t.status, body_hash: bodyHash(body), notes: t.notes, at: new Date().toISOString() };
}

async function saveBody(a: DraftArgs, c: Content, tx: ContentTx): Promise<Content | R> {
  const angle = c.draftPath?.angle;
  const provenance = modelWrite(a.host, angle ? { direction: angle.main_line } : undefined);
  try {
    const saved = await tx.write({ ...(a.title ? { title: a.title } : {}), body: a.body!, writtenBy: { kind: "host", host: a.host },
      // 看板交出去的稿没调 start 直接存了一版，也算接手（spec 2026-10-15 §B5）
      ...(c.writingHandoff && !c.writingHandoff.pickedUpAt ? { writingHandoff: { ...c.writingHandoff, pickedUpAt: new Date().toISOString(), pickedUpBy: a.host } } : {}),
      _versionNote: a.note ?? "AI 写入", _editor: "agent", _provenance: provenance });
    return saved ?? fail("not_found", `稿件不存在：${c.id}`);
  } catch (err) {
    if (err instanceof FirstBodyRefusedError) return fail("needs_angle", "还没记录创始人选定的立意：先出 3 个立意让创始人选，用 angle 记下再存稿", { detail: err.refusal.error, next_action: { tool: "autocrew_draft", params: { action: "angle", content_id: c.id } } });
    if (err instanceof ScriptFrozenError) return fail("script_frozen", err.message);
    throw err;
  }
}

/** 存一版（正文没变就不出新版本），再把审稿意见 / 试读 / 改稿意见挂到这一版上 */
async function writeVersion(a: DraftArgs, c: Content, tx: ContentTx): Promise<R> {
  const bodyChanged = a.body !== c.body || Boolean(a.title && a.title !== c.title);
  const saved = await saveBody(a, c, tx);
  if (!("id" in saved)) return saved;
  const s = saved as Content;
  const version = currentVersion(s);
  const at = new Date().toISOString();
  const dp = s.draftPath!;
  const notes: DraftReviewNote[] = a.reviewNotes !== undefined ? [...(dp.reviewNotes ?? []), { version, notes: a.reviewNotes as DraftReviewNote["notes"], at }] : dp.reviewNotes ?? [];
  const reads = a.testRead ? [...(dp.testReads ?? []), testReadRecord(a.testRead as TestReadInput, version, s.body)] : dp.testReads ?? [];
  const input = a.feedback && typeof a.feedback === "object" ? a.feedback : null;
  // 同一版同一句原话重放（重试）不重复记
  const replay = Boolean(input && dp.feedback?.some((f) => f.version === version && f.founder_words === input.founder_words));
  const fb = input && !replay ? feedbackRecord(input, version, c, bodyChanged) : null;
  if (a.reviewNotes !== undefined || a.testRead || fb) {
    await tx.write({ draftPath: { ...dp, reviewNotes: notes, testReads: reads, ...(fb ? { feedback: [...(dp.feedback ?? []), fb] } : {}) } });
  }
  return { ok: true, version, status: s.status, body_changed: bodyChanged, reviewed: notes.length > 0 || reads.length > 0,
    format_warnings: FORMAT_MARKS.filter(([re]) => re.test(a.body!)).map(([, msg]) => msg),
    ...(fb ? { feedback_recorded: { index: (dp.feedback?.length ?? 0) + 1, version } } : {}),
    ...(replay ? { feedback_replayed: true } : {}), ...(input?.lessons.length ? { lessons_note: LESSONS_DEFERRED } : {}),
    // O20：示例稿的意见照记在稿上，但不进跨稿学习
    ...(input && c.example ? { lessons_skipped: "这是示例稿：意见记在稿上，不进写作规则和手册学习" } : {}) };
}

function argRefusal(a: DraftArgs): R | null {
  if (a.reviewNotes === INVALID) return fail("bad_param", "review_notes 解析不了：传一段文字，或一个 JSON 对象 / 数组（不超过 2 万字）");
  if (typeof a.feedback === "string") return fail("bad_param", a.feedback);
  if (typeof a.testRead === "string") return fail("bad_param", a.testRead);
  return bodyRefusal(a.body);
}

export async function draftSave(a: DraftArgs): Promise<R> {
  const bad = argRefusal(a);
  if (bad) return bad;
  const r = await withVersion(a, async (c, tx) => {
    const real = await isRealDraft(c, a.dataDir);
    // 第一版是按立意写的，没有意见可记
    if (a.feedback && !real) return fail("bad_param", "feedback 只在已有一版正文之后收：第一版按立意写，不带 feedback；开头阶段的意见用 opening 记");
    if (!real && needsOpening(c.draftPath?.angle)) return fail("needs_opening", "还没选开头：先给创始人 3 个开头挑（opening{candidates}），他选了用 opening{opening, founder_words} 记下，再写全文", { next_action: { tool: "autocrew_draft", params: { action: "opening", content_id: c.id } } });
    if (a.testRead && a.body !== c.body && real) return fail("bad_param", "test_read 要附在它读的那一版上：body 传试读时读的那一版正文原文（和当前版一样），改过的稿先 save 再试读");
    return writeVersion(a, c, tx);
  });
  // 已出过定稿清单的稿又改了：退回写作中（锁外推进，状态机照常校验）
  if (r.ok && r.status === "draft_ready" && r.body_changed) await transitionStatus(a.contentId!, "drafting", { host: a.host }, a.dataDir);
  if (!r.ok) return r;
  const note = draftNextNote({ id: a.contentId!, status: r.status === "draft_ready" && !r.body_changed ? "draft_ready" : "drafting", needsAngle: false, hasBody: true, reviewed: r.reviewed as boolean, checklistCurrent: !r.body_changed });
  return { ...r, status: undefined, reviewed: undefined, workbench_url: workbenchUrl(a.contentId!), next_action: { note } };
}
