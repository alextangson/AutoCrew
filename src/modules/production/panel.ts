/**
 * 卡片面板（spec §10 一期最小面板）要的数据：阶段、还差什么、候选（是这条 / 不是这条）、待核发布回执、
 * 「我发了」记录（可纠正）、当前批准（往回拖撤哪个）、登记核对清单的位置、能不能重开文稿。只读。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, type Content } from "../../storage/local-store.js";
import { CHATCUT_USES, IN_EDIT_REASSIGN, undoBlocker } from "./undo-attach.js";
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
function arollRows(content: Content, doc: ProductionDoc): Array<Record<string, unknown>> {
  return doc.facts.filter((f) => f.round === doc.round && f.kind === "aroll" && f.state === "accepted").map((f) => {
    const blocked = undoBlocker(content, doc, f);
    return { fact_id: f.id, sha256: f.sha256, path: f.path, auto_attached: f.auto_attached === true, source_path: f.source_path ?? null,
      check: f.attach_check ?? null, undo_blocked: blocked, reassign_blocked: blocked ? (blocked === CHATCUT_USES ? blocked : IN_EDIT_REASSIGN) : null };
  });
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
    ...base, round: doc.round, arolls: arollRows(content, doc),
    pending_receipts: receipts.pending.map((w) => ({ fact_id: w.fact_id, slot_id: w.id, platform: w.platform, url: w.url ?? (w.item_id ? `作品 ${w.item_id}` : null), host: w.source === "claim" ? w.host ?? "AI" : "数据回流" })),
    published,
    approvals: { cut: cut ? { id: cut.id, sha256: cut.sha256 } : null, cover: cover ? { id: cover.id } : null },
    slivers: sliverPanel(doc, cut?.sha256),
    storyboard: await storyboardPanel(contentId, dataDir, doc),
    checklist,
    // 已发布的也能重开（创始人 09-30），确认框单独说明；published = 这张卡现在是已发布
    can_reopen: doc.facts.some((f) => f.round === doc.round && f.state === "accepted") || doc.decisions.some((d) => d.round === doc.round && d.type === "script_approval"),
    published_now: receipts.live.length > 0 || content.status === "published",
    // 以前几轮的发布槽：留作历史，不算进本轮
    past_receipts: pastSlots(doc),
  };
}
