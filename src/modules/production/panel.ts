/**
 * 卡片面板（spec §10 一期最小面板）要的数据：阶段、还差什么、候选（是这条 / 不是这条）、待核发布回执、
 * 「我发了」记录（可纠正）、当前批准（往回拖撤哪个）、登记核对清单的位置、能不能重开文稿。只读。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../storage/local-store.js";
import { contentRoot } from "../../storage/content-project.js";
import { isOntologyActive, readProductionDocOrEmpty } from "../../storage/production-store.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { spokenRel } from "../video/handoff/register-spoken.js";
import { publishReceipts, validCoverApproval, validCutApproval } from "./derive.js";
import type { Slot } from "./receipts.js";
import { explainContent } from "./read.js";
import { isUngated } from "./publish-check-link.js";

/** 这个槽的状态由谁定：给创始人看的来源说法 */
function slotLabel(w: Slot): string {
  if (w.by === "founder") return w.source === "founder" && w.fact_id ? "你确认过 AI 说的发布" : "你标了已发布";
  if (w.source === "metrics_id") return "数据回流按作品 id 对上";
  return "发布计划里的记录";
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
    ...base, round: doc.round,
    pending_receipts: receipts.pending.map((w) => ({ fact_id: w.fact_id, slot_id: w.id, platform: w.platform, url: w.url ?? (w.item_id ? `作品 ${w.item_id}` : null), host: w.source === "claim" ? w.host ?? "AI" : "数据回流" })),
    published,
    approvals: { cut: cut ? { id: cut.id, sha256: cut.sha256 } : null, cover: cover ? { id: cover.id } : null },
    checklist,
    can_reopen: doc.facts.some((f) => f.round === doc.round && f.state === "accepted") || doc.decisions.some((d) => d.round === doc.round && d.type === "script_approval"),
  };
}
