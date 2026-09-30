/**
 * 卡片面板（spec §10 一期最小面板）要的数据：阶段、还差什么、候选（是这条 / 不是这条）、待核发布回执、
 * 「我发了」记录（可纠正）、当前批准（往回拖撤哪个）、登记核对清单的位置、能不能重开文稿。只读。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, type Content } from "../../storage/local-store.js";
import { CHATCUT_USES, IN_EDIT_REASSIGN, noOriginalPlace, undoBlocker } from "./undo-attach.js";
import { candidateRow, originOf, type CandidateRow, type SourceDirs } from "./candidate-view.js";
import type { Fact } from "../../storage/production-types.js";
import { movableRoots } from "./roots.js";
import { readArollSources } from "./sources.js";
import { contentRoot } from "../../storage/content-project.js";
import { isOntologyActive, readProductionDocOrEmpty } from "../../storage/production-store.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { spokenRel } from "../video/handoff/register-spoken.js";
import { publishReceipts, validCoverApproval, validCutApproval } from "./derive.js";
import { canonPlatform, slotOf, type Slot } from "./receipts.js";
import type { ProductionDoc } from "../../storage/production-types.js";
import { explainContent } from "./read.js";
import { isUngated } from "./publish-check-link.js";
import { currentCut } from "./sliver/check.js";
import { storyboardPanel } from "./storyboard.js";
import { markedCuts } from "./ready.js";
import { isStrayCover } from "./plain-reason.js";
import { hostLabel } from "./host-label.js";
import { NO_RESULT, sliverKey, sliverVerdict, sliverWaived } from "./sliver/verdict.js";

/** 这个槽的状态由谁定：给创始人看的来源说法 */
function slotLabel(w: Slot): string {
  if (w.by === "founder") return w.source === "founder" && w.fact_id ? "你确认过 AI 说的发布" : "你标了已发布";
  if (w.source === "metrics_id") return "数据回流按作品 id 对上";
  return "发布计划里的记录";
}

function pastSlots(doc: ProductionDoc): Array<{ round: number; platform: string; label: string; url: string | null; at: string }> {
  const out: Array<{ round: number; platform: string; label: string; url: string | null; at: string }> = [];
  const pairs = new Set(doc.facts.filter((f) => f.kind === "publish" && f.round < doc.round).map((f) => `${f.round}\u0000${f.platform ?? "?"}`));
  for (const d of doc.decisions.filter((x) => x.type === "i_published" && x.round < doc.round && x.platform)) pairs.add(`${d.round}\u0000${d.platform}`);
  const seen = new Set<string>();
  for (const key of pairs) {
    const [round, platform] = key.split("\u0000");
    const s = slotOf(doc, Number(round), canonPlatform(platform));
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ round: s.round, platform: s.platform, label: `第 ${s.round} 轮 · ${slotLabel(s)}`, url: s.url ?? null, at: s.at });
  }
  return out.sort((a, b) => b.round - a.round || Date.parse(b.at) - Date.parse(a.at));
}

/**
 * 抽帧检查（spec 2026-09-30 §6）：当前成片还没通过时，列每处缝（时间码、前后条目、修法、放没放行）或没跑成的原因，
 * 以及能不能整条放行。已通过的成片不回溯拦，不再列。
 */
function sliverPanel(doc: ProductionDoc, approvedSha: string | undefined): Record<string, unknown> | null {
  const cut = currentCut(doc);
  if (!cut?.sha256 || approvedSha === cut.sha256) return null;
  const v = sliverVerdict(doc, cut.sha256, null);
  const c = v.check;
  return {
    cut_sha: cut.sha256, cut_fact_id: cut.id, status: c?.status ?? "none", reason: c?.reason ?? (c ? null : NO_RESULT), fingerprint: c?.fingerprint ?? null,
    checked_at: c?.checked_at ?? null, blocked: !v.ok, missing: v.missing ?? null,
    whole_waivable: v.wholeWaivable && !v.wholeWaived, whole_waived: v.wholeWaived,
    items: (c?.slivers ?? []).map((s) => ({ ...s, key: sliverKey(s), waived: sliverWaived(doc, cut.sha256!, c!.fingerprint, s) })),
  };
}

/**
 * 本轮 accepted 原片（1b §4.1 / §7）：自动挂上的给「不是这条」，核对说更像别条的给「改挂到《X》」/「就是这条」；
 * 前提不满足时不给按钮，给原因（「这条已经在剪了…」）。
 */
/** 这段原片是怎么来的（人话）：自动挂的、创始人从哪儿确认的、agent 报的、创始人挂的 */
function arollOrigin(f: Fact, doc: ProductionDoc, dirs: SourceDirs): string {
  if (f.auto_attached) return f.source === "reconcile" ? "收件箱自动挂上" : "核对后自动挂上";
  if (f.source === "founder") return "你挂的";
  if (f.source === "record") return "agent 报的";
  const confirmed = doc.decisions.some((d) => d.type === "candidate_confirm" && d.fact_id === f.id);
  const where = originOf({ ...f, path: f.source_path ?? f.path }, dirs);
  const known = where === "收件箱" || where.startsWith("监视文件夹") || where.endsWith("导出");
  return confirmed ? (known ? `你从${where}确认的` : "你确认的") : where;
}

async function arollRows(content: Content, doc: ProductionDoc, dataDir: string, dirs: SourceDirs): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const f of doc.facts.filter((x) => x.round === doc.round && x.kind === "aroll" && x.state === "accepted")) {
    const blocked = undoBlocker(content, doc, f);
    const noHome = await noOriginalPlace(content, f, dataDir);
    out.push({ fact_id: f.id, sha256: f.sha256, path: f.path, name: path.basename(f.source_path ?? f.path ?? ""), origin: arollOrigin(f, doc, dirs),
      duration_ms: f.duration_ms ?? null, at: f.at, auto_attached: f.auto_attached === true, source_path: f.source_path ?? null,
      check: f.attach_check ?? null, undo_blocked: noHome ?? blocked, reassign_blocked: blocked ? (blocked === CHATCUT_USES ? blocked : IN_EDIT_REASSIGN) : null });
  }
  return out;
}

async function sourceDirs(dataDir: string): Promise<SourceDirs> {
  const roots = await movableRoots(dataDir);
  const folders = (await readArollSources(dataDir).catch(() => ({ folders: [] as Array<{ path: string }> }))).folders.map((f) => f.path);
  return { inbox: roots.inbox, chatcut: roots.chatcut, jianying: roots.jianying, watch: [...new Set([...(roots.watch ?? []), ...folders])] };
}

async function candidateRows(contentId: string, doc: ProductionDoc, dataDir: string): Promise<CandidateRow[]> {
  const dirs = await sourceDirs(dataDir);
  return doc.facts.filter((f) => f.round === doc.round && (f.state === "candidate" || f.state === "pending_match") && !isStrayCover(f))
    .sort((a, b) => b.at.localeCompare(a.at)).map((f) => candidateRow(f, contentId, dirs));
}

/**
 * B7：本轮有收下的成片、却没有一版被 agent 标「可以审了」（也还没通过）→ 卡上说「有 N 个导出，X 还没说可以审了」，
 * 给创始人「我现在就要审」。
 */
function unreviewedExports(doc: ProductionDoc, approvedSha: string | undefined): { count: number; editor_label: string } | null {
  if (approvedSha || markedCuts(doc).length) return null;
  const cuts = doc.facts.filter((f) => f.round === doc.round && f.kind === "cut" && f.state === "accepted" && !f.replaced_at);
  if (!cuts.length) return null;
  return { count: cuts.length, editor_label: hostLabel(cuts.map((f) => f.by?.host).filter(Boolean).at(-1)) };
}

function strayCovers(doc: ProductionDoc): { count: number } | null {
  const n = doc.facts.filter((f) => f.round === doc.round && isStrayCover(f)).length;
  return n ? { count: n } : null;
}

export async function cardPanel(contentId: string, dataDir: string): Promise<Record<string, unknown>> {
  const content = await getContent(contentId, dataDir);
  if (!content || content.deletedAt) return { ok: false, code: "not_found", error: "这条稿不在了" };
  const active = isVideoPlatform(content.platform) && (await isOntologyActive(dataDir, contentId));
  const exp = await explainContent(content, dataDir);
  const base = { ok: true, id: content.id, title: content.title, platform: content.platform ?? null, status: content.status, active,
    column: exp.column, stage: exp.stage, reason: exp.reason, missing: exp.missing, badges: exp.badges, alerts: exp.alerts, candidates: exp.candidates };
  if (!active) return base;
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const receipts = publishReceipts(doc);
  // 一行 = 一个平台的发布槽（本轮每个平台只有一个）；纠正指向槽 id；按真实时间新的在前
  const published = receipts.live.map((w) => ({ id: w.id, kind: "slot", platform: w.platform, url: w.url ?? null, work: w.item_id ?? null,
    label: `${slotLabel(w)}${isUngated(w.gate) ? " · 发布前未把关" : ""}`, ungated: isUngated(w.gate), overrides: w.gate?.overrides ?? [], at: w.at }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const n = doc.registrations.length;
  const checklistRel = n ? spokenRel(n).replace(/-spoken\.md$/, "-checklist.json") : null;
  const checklist = checklistRel && (await fs.stat(path.join(contentRoot(contentId, dataDir), checklistRel)).then(() => true, () => false)) ? checklistRel : null;
  const cut = validCutApproval(doc, content.body), cover = validCoverApproval(doc, content.body);
  return {
    ...base, round: doc.round, arolls: await arollRows(content, doc, dataDir, await sourceDirs(dataDir)), candidate_rows: await candidateRows(content.id, doc, dataDir),
    pending_receipts: receipts.pending.map((w) => ({ fact_id: w.fact_id, slot_id: w.id, platform: w.platform, url: w.url ?? (w.item_id ? `作品 ${w.item_id}` : null), host: w.source === "claim" ? w.host ?? "AI" : "数据回流" })),
    published,
    approvals: { cut: cut ? { id: cut.id, sha256: cut.sha256 } : null, cover: cover ? { id: cover.id } : null },
    slivers: sliverPanel(doc, cut?.sha256),
    unreviewed: unreviewedExports(doc, cut?.sha256),
    // 正式封面文件夹以外的封面图（多半是中间文件）：只在制作中的稿卡上收成一行，给「都不要」；已发布的不提
    stray_covers: exp.stage && exp.stage !== "已发布" ? strayCovers(doc) : null,
    storyboard: await storyboardPanel(contentId, dataDir, doc),
    checklist,
    // 已发布的也能重开（创始人 09-30），确认框单独说明；published = 这张卡现在是已发布
    can_reopen: doc.facts.some((f) => f.round === doc.round && f.state === "accepted") || doc.decisions.some((d) => d.round === doc.round && d.type === "script_approval"),
    published_now: receipts.live.length > 0 || content.status === "published",
    // 以前几轮的发布槽：留作历史，不算进本轮
    past_receipts: pastSlots(doc),
  };
}
