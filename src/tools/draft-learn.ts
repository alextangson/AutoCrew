/**
 * 改稿意见怎么学（spec 2026-10-15 §6、§15.6–15.8）：
 * - feedback_history：跨稿读意见（抖音这条路上所有稿存下的创始人原话，带 content_id 和第几条），只读。
 * - propose_promotion：同一个意思在至少两篇不同的稿里出现过才提升级。出处由服务端逐条核对（稿在、第几条存在）。
 *   升级到手册骨架 → 走现有手册提案与版本机制；升级成范文批注 / 写法 → 进「等你拍板」，批了范文出新版本、写法出补丁等发布。
 *   不再生成档案规则。
 */
import { listContents, type Content } from "../storage/local-store.js";
import { DRAFT_PLATFORM } from "../modules/draft/draft-types.js";
import type { Cite } from "../modules/draft/draft-args-extra.js";
import { proposeRevision } from "../modules/playbook/changes.js";
import { entryOf, loadManifest } from "../modules/playbook/store.js";
import { isPlaybookId, PlaybookError } from "../modules/playbook/types.js";
import { readExemplarManifest } from "../modules/exemplar/store.js";
import { proposePromotion, type PromotionCite } from "../modules/exemplar/promotions.js";
import { fail } from "./draft-version.js";
import type { DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;
const HISTORY_MAX = 300;
const TARGETS = ["playbook", "exemplar", "method"];

const douyinDrafts = async (dataDir?: string): Promise<Content[]> =>
  (await listContents(dataDir)).filter((c) => !c.deletedAt && c.platform === DRAFT_PLATFORM && c.draftPath?.feedback?.length);

export async function draftFeedbackHistory(a: DraftArgs): Promise<R> {
  const rows = (await douyinDrafts(a.dataDir)).flatMap((c) => (c.draftPath!.feedback ?? []).map((f, i) => ({
    content_id: c.id, title: c.title, index: i + 1, version: f.version, stage: f.stage ?? "body", genre: f.playbook?.id ?? c.draftPath?.angle?.playbook?.id ?? null,
    founder_words: f.founder_words, at: f.at, ...(f.deferred_lessons?.length ? { deferred_lessons: f.deferred_lessons.map((l) => l.rule) } : {}),
  })));
  const filtered = a.genre ? rows.filter((r) => r.genre === a.genre) : rows;
  const recent = filtered.sort((x, y) => y.at.localeCompare(x.at)).slice(0, HISTORY_MAX);
  return { ok: true, count: recent.length, total: filtered.length, entries: recent,
    next_action: { note: "把这篇的意见和别的稿的比：同一个意思在另外至少一篇不同的稿里也出现过，才用 propose_promotion 提升级（cites 带两篇稿的 {content_id, index}）；只在一篇里出现的不提" } };
}

/** 出处逐条核：稿在、第几条存在；至少两篇不同的稿 */
async function resolveCites(cites: Cite[], dataDir?: string): Promise<PromotionCite[] | string> {
  const byId = new Map((await douyinDrafts(dataDir)).map((c) => [c.id, c]));
  const out: PromotionCite[] = [];
  for (const c of cites) {
    const f = byId.get(c.content_id)?.draftPath?.feedback?.[c.index - 1];
    if (!f) return `出处对不上：稿 ${c.content_id} 没有第 ${c.index} 条意见（用 feedback_history 里给的编号）`;
    out.push({ content_id: c.content_id, index: c.index, founder_words: f.founder_words });
  }
  if (new Set(out.map((c) => c.content_id)).size < 2) return "升级要至少两篇不同的稿里都出现过同一个意思：cites 里只有一篇稿";
  return out;
}

function promotionRefusal(a: DraftArgs): R | null {
  if (typeof a.cites === "string") return fail("bad_param", a.cites);
  if (!a.target || !TARGETS.includes(a.target)) return fail("bad_param", "target 只能是 playbook（改手册骨架）/ exemplar（给范文加批注）/ method（改写法里的一条）；不再生成档案规则");
  if (!a.cites?.length) return fail("bad_param", "要带 cites：两篇不同稿的意见出处 [{content_id, index}]");
  if (!a.text?.trim()) return fail("bad_param", a.target === "playbook" ? "text 是改后的手册全文" : "text 是批注（改前 → 改后片段）或写法改动的全文");
  if (!a.note) return fail("bad_param", "note 写为什么升级（一句）");
  return null;
}

async function toPlaybook(a: DraftArgs, cites: PromotionCite[]): Promise<R> {
  if (!isPlaybookId(a.genre)) return fail("bad_genre", "升级到手册要带 genre：哪本手册");
  const current = entryOf(await loadManifest(a.dataDir), a.genre).current;
  const words = cites.map((c) => `「${c.founder_words}」`).join(" / ");
  try {
    const r = await proposeRevision({ id: a.genre, based_on: current, text: a.text!, reason: `${a.note}（出处：${cites.map((c) => `${c.content_id}#${c.index}`).join("、")}）`, founder_words: words }, a.dataDir);
    return { ...r, target: "playbook", next_action: { note: "已进「等你拍板」：定稿时告诉创始人有一份手册改动等他批（autocrew_review_inbox list 里 playbook_change）" } };
  } catch (e) {
    if (e instanceof PlaybookError) return fail(e.code, e.message, e.extra);
    throw e;
  }
}

export async function draftProposePromotion(a: DraftArgs): Promise<R> {
  const bad = promotionRefusal(a);
  if (bad) return bad;
  const cites = await resolveCites(a.cites as Cite[], a.dataDir);
  if (typeof cites === "string") return fail("bad_cites", cites);
  if (a.target === "playbook") return toPlaybook(a, cites);
  if (a.target === "exemplar") {
    if (!a.exemplarId) return fail("bad_param", "给范文加批注要带 exemplar_id");
    if (!(await readExemplarManifest(a.dataDir)).exemplars.some((e) => e.id === a.exemplarId)) return fail("not_found", `范文库里没有 ${a.exemplarId}`);
  }
  const r = await proposePromotion({ target: a.target as "exemplar" | "method", ...(a.exemplarId ? { exemplar_id: a.exemplarId } : {}), text: a.text!, reason: a.note!, cites }, a.dataDir);
  return { ok: true, target: a.target, ...r, next_action: { note: "已进「等你拍板」（writing_promotion）。批了范文出新版本、写法出补丁（显示「已批，等发布」）" } };
}
