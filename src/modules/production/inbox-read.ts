/**
 * 「等你拍板」的读方（review-inbox §3）：收集每条稿的输入交给纯函数 `contentItems`，外加全库的条目
 * （写作规则 / 发布偏好提案；收件箱里的视频不再列——创始人在对话里说是哪条）。只读，零写入（看板读零写入沿用）。
 */
import { isImportedHistory } from "../../storage/imported-history.js";
import fs from "node:fs/promises";
import path from "node:path";
import { listContents, type Content } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import type { ProductionDoc } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { readPublishRecord } from "../../storage/publish-record.js";
import { loadProfile, ruleStatus, type CreatorProfile, type WritingRule } from "../profile/creator-profile.js";
import { activeRuleCount, RULE_CAP } from "../profile/writing-rules.js";
import { pendingProposals } from "../publish/review-gate/preferences.js";
import { checksDir } from "../publish/review-gate/check-store.js";
import { checkInputsNow } from "../publish/review-gate/check.js";
import { canonPlatform } from "./receipts.js";
import { attachmentsChanged } from "./asks.js";
import { withCoverGroups } from "./cover-groups.js";
import { explainContent, explainContext } from "./read.js";
import { loadHashCache } from "./hash-cache.js";
import { arollOwnerElsewhere } from "./sha-index.js";
import { approvedCoverShas } from "./service.js";
import { draftHash } from "../../storage/draft-hash.js";
import { FOUNDER_DECISION_SOURCES, readProjectJson, type ProjectDecisions } from "../video/handoff/project-evidence.js";
import { loadManifest, readVersionText } from "../playbook/store.js";
import { paragraphDiff } from "../playbook/diff.js";
import { promotionItems } from "./chat-approval/promotion-decide.js";
import type { PlaybookEntry, PlaybookProposal } from "../playbook/types.js";
import { articleReviewState, isDerivedArticle } from "../wechat-article/review.js";
import { enReviewState, isEnEdition } from "../en-edition/review.js";
import { enPackageState, reopenReason } from "../en-edition/package.js";
import { contentItems, genOf, sortItems, type CheckView, type ContentInput, type InboxItem } from "./inbox.js";
import { DELETED_CONTENT, lessonQuestion, mergeKeyOf, wordsLine } from "./lesson-view.js";

/** 稿件 id → 稿名（删了的也算，取得到就显示）；取不到 =「已删的稿」 */
type Titles = Map<string, string>;
const titleOf = (titles: Titles, id: string | null | undefined) => (id ? titles.get(id) ?? DELETED_CONTENT : null);

interface CheckRec { check_id?: string; content_id?: string; platform?: string; checked_at?: string; input_at?: string; verdict?: string; round?: number; items?: unknown[] }

/** 谁更新：先比输入代次（开始读计划的时间，破例重跑沿用原检查的），再比完成时间，最后比 id */
const newer = (a: CheckRec, b: CheckRec) => {
  const ka = a.input_at ?? a.checked_at!, kb = b.input_at ?? b.checked_at!;
  return ka !== kb ? ka > kb : a.checked_at !== b.checked_at ? a.checked_at! > b.checked_at! : a.check_id! > b.check_id!;
};

/**
 * 每个平台当前有效的一组检查（§7-4）：本轮、同平台最新的那一次；更早的算「已被新检查取代」，不出条目。
 * 旧检查没记轮次：检查时间在本轮开始之后（或第一轮）才算本轮。已点过「没问题」的不再出。
 */
export async function currentChecks(content: Content, doc: ProductionDoc | null, dataDir: string): Promise<CheckView[]> {
  let dir: string;
  try { dir = checksDir(content.id, dataDir); } catch { return []; }
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^chk-[\w-]+\.json$/.test(n));
  const round = doc?.round ?? 1;
  const since = doc?.round_started_at ? Date.parse(doc.round_started_at) : -Infinity;
  const latest = new Map<string, CheckRec>();
  // 作废的（破例被拒、留档删不掉）不参与「最新」：同平台取下一份
  const voided = new Set((doc?.decisions ?? []).filter((d) => d.type === "publish_check_void" && d.check_id).map((d) => d.check_id!));
  for (const n of names) {
    const r = JSON.parse(await fs.readFile(path.join(dir, n), "utf8").catch(() => "null")) as CheckRec | null;
    if (!r?.check_id || voided.has(r.check_id) || r.content_id !== content.id || !r.platform || !r.checked_at) continue;
    const inRound = r.round !== undefined ? r.round === round : round === 1 || Date.parse(r.checked_at) >= since;
    if (!inRound) continue;
    const p = canonPlatform(r.platform);
    const prev = latest.get(p);
    if (!prev || newer(r, prev)) latest.set(p, r);
  }
  const confirmed = new Set((doc?.decisions ?? []).filter((d) => d.type === "publish_check_confirm" && d.check_id).map((d) => d.check_id!));
  return [...latest.entries()].filter(([, r]) => !confirmed.has(r.check_id!))
    .map(([p, r]) => ({ check_id: r.check_id!, platform: p, verdict: r.verdict ?? "pass", checked_at: r.checked_at!, items: r.items ?? [] }))
    .map(async (v) => ({ ...v, input: await checkInputsNow(content.id, v.check_id, dataDir).catch(() => ({ same: false, fp: "unreadable" })) }))
    .reduce(async (acc, x) => [...(await acc), await x], Promise.resolve([] as CheckView[]));
}

async function plannedPlatforms(content: Content, dataDir: string): Promise<string[]> {
  const record = await readPublishRecord(content.id, undefined, dataDir).catch(() => ({ kind: "none" as const }));
  const fromPlan = record.kind === "none" ? [] : record.platforms.map((p) => canonPlatform(p.platform));
  const list = fromPlan.length ? fromPlan : content.platform ? [canonPlatform(content.platform)] : [];
  return [...new Set(list)];
}

/** 派生公众号文章的整包指纹；读不出来就用读不出的原因占位（代次照样变，不拿旧代次批） */
async function articlePackageHashOf(id: string, dataDir: string): Promise<string> {
  const s = await articleReviewState(id, dataDir).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  return "hash" in s ? s.hash : `unreadable:${s.error}`;
}

/** 英文版的脚本指纹（认稿那件批的是这份脚本，Phase 3）；读不出同上 */
async function enScriptHashOf(id: string, dataDir: string): Promise<string> {
  const s = await enReviewState(id, dataDir).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  return "hash" in s ? s.hash : `unreadable:${s.error}`;
}

/** 英文发布包现状（批过之后进了制作段才算）；读不出来照样出那件，原因写进 problems */
async function enPackageOf(id: string, dataDir: string): Promise<ContentInput["enPackage"]> {
  const s = await enPackageState(id, dataDir).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  if ("error" in s) return { hash: `unreadable:${s.error}`, problems: [s.error], approved: false, reopen: s.error };
  return { hash: s.hash, problems: s.problems, approved: s.approval.ok, reopen: reopenReason(s) };
}

async function contentInput(c: Content, dataDir: string, ctx: Awaited<ReturnType<typeof explainContext>>): Promise<ContentInput> {
  const video = isVideoPlatform(c.platform);
  const active = video && ctx.enabled && !ctx.excluded.has(c.id);
  const raw = await readProductionDoc(c.id, dataDir).catch(() => null);
  const doc = active && raw ? withCoverGroups(raw, approvedCoverShas(raw, c.body)) : null;
  const exp = active ? await explainContent(c, dataDir, ctx) : null;
  const askAttachmentsChanged: Record<string, boolean> = {};
  for (const a of (doc?.asks ?? []).filter((x) => x.state === "open" && x.attachments.length)) askAttachmentsChanged[a.id] = await attachmentsChanged(c.id, a, dataDir);
  const needsPlan = exp?.stage === "待发布" || exp?.stage === "已发布";
  // 同一段原片已经归了别条稿（比如创始人在那条卡上挂了它）：这条上的候选是过期的（verifier 2a P2）
  const ownedElsewhere = new Set<string>();
  for (const f of (doc?.facts ?? []).filter((x) => x.round === doc!.round && x.kind === "aroll" && x.state === "candidate" && x.sha256)) {
    if (await arollOwnerElsewhere(dataDir, f.sha256!, c.id).catch(() => null)) ownedElsewhere.add(f.id);
  }
  const handoffCoverText = doc ? await confirmedCoverText(c, dataDir) : "";
  const articlePackageHash = c.status !== "draft_ready" ? undefined
    : isDerivedArticle(c) ? await articlePackageHashOf(c.id, dataDir) : isEnEdition(c) ? await enScriptHashOf(c.id, dataDir) : undefined;
  return { content: c, doc: active ? doc ?? null : null, exp, askAttachmentsChanged, checks: video ? await currentChecks(c, raw, dataDir) : [], planned: needsPlan ? await plannedPlatforms(c, dataDir) : [], log: raw?.inbox_log ?? [], ownedElsewhere,
    ...(handoffCoverText ? { handoffCoverText } : {}), ...(articlePackageHash ? { articlePackageHash } : {}),
    ...(isEnEdition(c) && exp?.phase === "production" ? { enPackage: await enPackageOf(c.id, dataDir) } : {}) };
}

/** 创始人交接时确认的封面字：只认创始人来源、且对得上当前定稿的决定 */
async function confirmedCoverText(c: Content, dataDir: string): Promise<string> {
  const d = await readProjectJson<ProjectDecisions>(c.id, "decisions.json", dataDir).catch(() => null);
  if (!d || !FOUNDER_DECISION_SOURCES.has(d.source) || d.draft_hash !== draftHash(c)) return "";
  return typeof d.cover_text === "string" ? d.cover_text.trim() : "";
}

/**
 * 待批写作规则（spec 2026-10-10 §C）：能在对话里定（writing_rule）；从改稿意见来的挂那篇稿的 content_id。
 * detail 带规则原文、作用域、出处原话、冲突规则原文、现在生效数与上限。
 */
function ruleItem(r: WritingRule, profile: CreatorProfile, titles: Titles): InboxItem {
  const item_id = `rule:${r.id ?? genOf(r.rule)}`;
  const c = r.conflictsWith ? profile.writingRules.find((x) => x.id === r.conflictsWith) : undefined;
  const words = r.origin?.founder_words ?? null;
  const active = profile.writingRules.filter((x) => ruleStatus(x) === "active").map((x) => ({ id: x.id ?? null, rule: x.rule }));
  return { item_id, gen: genOf([item_id, r.revision ?? 0]), type: "writing_rule", content_id: r.origin?.content_id ?? null, title: "写作规则提案", summary: r.rule, waiting: null, agent_waiting: false,
    since: r.createdAt ?? new Date(0).toISOString(), rank: 4, actions: [],
    detail: { where: "settings/writing-rules", rule_id: r.id ?? null, revision: r.revision ?? 1, rule: r.rule, scope: r.scope ?? "voice_core", founder_words: words, quote: words,
      evidence: r.evidence ?? [], conflicts_with: c ? { id: c.id, rule: c.rule, status: ruleStatus(c) } : null, active_rule_count: activeRuleCount(profile), rule_cap: RULE_CAP,
      active_rules: active, chosen_option: r.origin?.chosen_option ?? null, words_text: wordsLine(words, r.origin?.chosen_option), question: lessonQuestion("writing_rule"),
      content_title: titleOf(titles, r.origin?.content_id) } };
}

/** 待批的手册改动（spec 2026-10-13 §3）：能在对话里定；从改稿意见来的挂那篇稿的 content_id。detail 带改前改后（只列改动段落） */
async function playbookItem(e: PlaybookEntry, p: PlaybookProposal, dataDir: string, titles: Titles): Promise<InboxItem> {
  const item_id = `playbook:${p.id}`;
  const diff = paragraphDiff(await readVersionText(e.id, p.based_on, dataDir), p.text);
  return { item_id, gen: p.gen, type: "playbook_change", content_id: p.origin?.content_id ?? null, title: `《${e.name}》手册改动提案`, summary: p.lesson ?? p.reason,
    waiting: null, agent_waiting: false, since: p.at, rank: 4, actions: [],
    detail: { where: "settings/playbooks", playbook: e.id, playbook_name: e.name, proposal_id: p.id, kind: p.kind, based_on: p.based_on, current: e.current,
      reason: p.reason, founder_words: p.founder_words || null, quote: p.founder_words || null, diff,
      content_ids: [...new Set([p.origin?.content_id, ...(p.origins ?? []).map((o) => o.content_id)].filter(Boolean))],
      lesson: p.lesson ?? null, gen: p.gen, chosen_option: p.chosen_option ?? null, words_text: wordsLine(p.founder_words, p.chosen_option), question: lessonQuestion("playbook_change", e.name),
      content_title: titleOf(titles, p.origin?.content_id), merge_key: mergeKeyOf({ kind: p.kind, playbook: e.id, based_on: p.based_on }) } };
}

/** 手册读不了：不悄悄当没有，列一件看得见的「其他」 */
async function playbookItems(dataDir: string, titles: Titles): Promise<InboxItem[]> {
  try {
    const m = await loadManifest(dataDir);
    const out: InboxItem[] = [];
    for (const e of m.playbooks) for (const p of e.proposals.filter((x) => x.status === "pending")) out.push(await playbookItem(e, p, dataDir, titles));
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [{ item_id: "playbook:error", gen: genOf(["playbook:error", msg]), type: "other", content_id: null, title: "体裁手册读不了", summary: msg, waiting: null, agent_waiting: false,
      since: new Date(0).toISOString(), rank: 4, actions: [], detail: { where: "settings/playbooks", error: msg } }];
  }
}

/** 其他（默认收起）：写作规则提案、手册改动提案、发布偏好提案 */
async function otherItems(dataDir: string, titles: Titles): Promise<InboxItem[]> {
  const out: InboxItem[] = [];
  const profile = await loadProfile(dataDir).catch(() => null);
  for (const r of (profile?.writingRules ?? []).filter((x) => ruleStatus(x) === "pending")) out.push(ruleItem(r, profile!, titles));
  out.push(...await playbookItems(dataDir, titles));
  out.push(...await promotionItems(dataDir));
  for (const p of await pendingProposals(dataDir).catch(() => [])) {
    const item_id = `pref:${p.id}`;
    out.push({ item_id, gen: genOf([item_id, p.at]), type: "other", content_id: null, title: "发布偏好提案", summary: Array.isArray(p.value) ? p.value.join(" / ") : p.value, waiting: null, agent_waiting: false,
      since: p.at, rank: 4, actions: [], detail: { where: "settings/publish-prefs", proposal_id: p.id, founder_quote: p.founder_quote } });
  }
  return out;
}

export interface InboxView { ok: true; items: InboxItem[]; count: number; agent_waiting: number; generated_at: string }

/** 全库「等你拍板」（contentId 给了就只算那一条稿，给 summary / 单一入口用） */
/** withDrafts：「稿子写好了」不进列表（看板卡片上有「等你认稿」），但认稿决定仍按这件事的代次走 */
export async function readInbox(dataDir: string, opts: { contentId?: string; now?: number; withDrafts?: boolean } = {}): Promise<InboxView> {
  await loadHashCache(dataDir);
  const ctx = await explainContext(dataDir);
  // 历史作品记录不进「等你拍板」
  const listed = await listContents(dataDir);
  const all = listed.filter((c) => !isImportedHistory(c));
  const contents = opts.contentId ? all.filter((c) => c.id === opts.contentId) : all;
  const items: InboxItem[] = [];
  for (const c of contents) {
    if (c.deletedAt || c.status === "archived" || isImportedHistory(c)) continue;
    items.push(...contentItems(await contentInput(c, dataDir, ctx), opts.now));
  }
  if (!opts.contentId) items.push(...(await otherItems(dataDir, new Map(listed.map((c) => [c.id, c.title])))));
  const sorted = sortItems(opts.withDrafts ? items : items.filter((i) => i.type !== "draft"));
  return { ok: true, items: sorted, count: sorted.length, agent_waiting: sorted.filter((i) => i.agent_waiting).length, generated_at: new Date().toISOString() };
}
