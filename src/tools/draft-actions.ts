/**
 * autocrew_draft 的写稿动作：read / cite / angle / save / review。prepare_final 在 draft-prepare.ts。
 * 写动作（cite / angle / save）先过写锁（draft-claims），再读稿做阶段判断。
 */
import { getContent, getTopic, saveTopic, transitionStatus, updateContent, type Content, type Topic } from "../storage/local-store.js";
import { FirstBodyRefusedError, isRealDraft, modelWrite } from "../storage/first-body-guard.js";
import { ScriptFrozenError } from "../storage/production-store.js";
import { recordFounderAngle } from "../modules/research/angle-gate.js";
import { gateDraftWrite } from "../modules/draft/draft-claims.js";
import { citeForDraft, readPageForDraft } from "../modules/draft/draft-research.js";
import { enqueueReview, reviewView } from "../modules/draft/codex-review-queue.js";
import { stageRefusal } from "./draft-start.js";
import { normalizeChain, type DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;
const fail = (code: string, error: string, extra: R = {}): R => ({ ok: false, code, error, ...extra });

/** 写动作的共同前置：稿在、走的是这条路、还在写稿段、写锁拿得到 */
export async function writable(a: DraftArgs): Promise<{ content: Content } | { refused: R }> {
  if (!a.contentId) return { refused: fail("bad_param", "要带 content_id（start 返回的那个）") };
  const content = await getContent(a.contentId, a.dataDir);
  if (!content) return { refused: fail("not_found", `稿件不存在：${a.contentId}`) };
  if (!content.draftPath) return { refused: fail("not_started", "这篇还没用 autocrew_draft 接手：先调 start{content_id}", { next_action: { tool: "autocrew_draft", params: { action: "start", content_id: content.id } } }) };
  const stage = stageRefusal(content);
  if (stage) return { refused: stage };
  const gate = await gateDraftWrite(content.id, { host: a.host, session: a.session, dataDir: a.dataDir }, a.takeover);
  if (!gate.ok) return { refused: gate as R };
  return { content };
}

export async function draftRead(a: DraftArgs): Promise<R> {
  if (!a.contentId || !a.url) return fail("bad_param", "read 要带 content_id 和 url");
  const content = await getContent(a.contentId, a.dataDir);
  if (!content?.draftPath) return fail("not_started", "先用 start 建稿或接手，再读网页");
  try { return await readPageForDraft(content.id, a.url, a.dataDir); }
  catch (err) { return fail("read_failed", `网页没抓下来：${err instanceof Error ? err.message : String(err)}`); }
}

export async function draftCite(a: DraftArgs): Promise<R> {
  if (!a.pageId || !a.quote?.trim()) return fail("bad_param", "cite 要带 page_id（read 返回的）和 quote（原网页里逐字复制的一段）");
  const w = await writable(a);
  if ("refused" in w) return w.refused;
  const r = await citeForDraft(w.content.id, a.pageId, a.quote, a.claim, a.dataDir);
  return r.ok ? { ok: true, evidence_id: r.evidence_id, duplicate: r.duplicate } : fail(r.code, r.error);
}

async function topicFor(c: Content, dataDir?: string): Promise<Topic> {
  const existing = c.topicId ? await getTopic(c.topicId, dataDir) : null;
  if (existing && !existing.deletedAt) return existing;
  const topic = await saveTopic({ title: c.title, description: c.title, tags: [], source: "autocrew_draft" }, dataDir);
  await updateContent(c.id, { topicId: topic.id }, dataDir);
  return topic;
}

export async function draftAngle(a: DraftArgs): Promise<R> {
  const chain = normalizeChain(a.chain);
  const missing = [["main_line", a.mainLine], ["for_whom", a.forWhom], ["opening", a.opening], ["why_viral", a.whyViral], ["founder_words", a.founderWords]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return fail("bad_param", `angle 缺：${missing.join("、")}。founder_words 照抄创始人选立意时的原话（说「你定」就记「你定」）`);
  if (!chain || chain.length < 4 || chain.length > 6) return fail("bad_param", `chain 要 4–6 行论证链，现在是 ${chain?.length ?? 0} 行`);
  const w = await writable(a);
  if ("refused" in w) return w.refused;
  const topic = await topicFor(w.content, a.dataDir);
  if (!await recordFounderAngle(topic, a.mainLine!, a.founderWords!, a.dataDir)) return fail("angle_failed", "立意没记上：选题记录写不进去");
  const version = (w.content.draftPath?.angle?.version ?? 0) + 1;
  const angle = { version, main_line: a.mainLine!, for_whom: a.forWhom!, opening: a.opening!, why_viral: a.whyViral!, chain, founder_words: a.founderWords!, at: new Date().toISOString() };
  await updateContent(w.content.id, { draftPath: { ...w.content.draftPath!, angle } }, a.dataDir);
  return { ok: true, angle_version: version, next_action: { note: "按选定的立意和论证链写全文，再 save" } };
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

export async function draftSave(a: DraftArgs): Promise<R> {
  const bad = bodyRefusal(a.body);
  if (bad) return bad;
  const w = await writable(a);
  if ("refused" in w) return w.refused;
  const c = w.content;
  const angle = c.draftPath?.angle;
  const provenance = modelWrite(a.host, angle ? { direction: angle.main_line } : undefined);
  let saved: Content | null;
  try {
    saved = await updateContent(c.id, { ...(a.title ? { title: a.title } : {}), body: a.body!, writtenBy: { kind: "host", host: a.host }, _versionNote: a.note ?? "AI 写入", _editor: "agent", _provenance: provenance }, a.dataDir);
  } catch (err) {
    if (err instanceof FirstBodyRefusedError) return fail("needs_angle", "还没记录创始人选定的立意：先出 3 个立意让创始人选，用 angle 记下再存稿", { detail: err.refusal.error, next_action: { tool: "autocrew_draft", params: { action: "angle", content_id: c.id } } });
    if (err instanceof ScriptFrozenError) return fail("script_frozen", err.message);
    throw err;
  }
  if (!saved) return fail("not_found", `稿件不存在：${c.id}`);
  if (saved.status === "draft_ready") await transitionStatus(c.id, "drafting", { host: a.host }, a.dataDir);
  const review = await firstReview(saved, a.dataDir);
  return {
    ok: true, version: saved.versions?.length ?? 1,
    format_warnings: FORMAT_MARKS.filter(([re]) => re.test(a.body!)).map(([, msg]) => msg),
    review,
    next_action: { note: "把稿子给创始人看；他提意见就只改他说的地方再 save；他说「定了」就调 prepare_final" },
  };
}

/** 第一版存下后自动审一次；之后只在 review{rerun:true} 时再审 */
async function firstReview(c: Content, dataDir?: string): Promise<R> {
  if (c.draftPath?.autoReviewQueued || !await isRealDraft(c, dataDir)) return reviewView(c.id, dataDir);
  await updateContent(c.id, { draftPath: { ...c.draftPath!, autoReviewQueued: true } }, dataDir);
  try { await enqueueReview(c.id, dataDir); }
  catch (err) { return { status: "failed", error: { code: "enqueue_failed", message: err instanceof Error ? err.message : String(err) } }; }
  return reviewView(c.id, dataDir);
}

export async function draftReview(a: DraftArgs): Promise<R> {
  if (!a.contentId) return fail("bad_param", "review 要带 content_id");
  const content = await getContent(a.contentId, a.dataDir);
  if (!content?.draftPath) return fail("not_started", "这篇不在 autocrew_draft 路径上");
  if (a.rerun) {
    if (!await isRealDraft(content, a.dataDir)) return fail("empty_body", "还没有正文可审");
    const r = await enqueueReview(content.id, a.dataDir);
    return { ok: true, coalesced: r.coalesced, review: await reviewView(content.id, a.dataDir) };
  }
  return { ok: true, review: await reviewView(content.id, a.dataDir) };
}
