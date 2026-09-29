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
import { explainContent } from "./read.js";

export async function cardPanel(contentId: string, dataDir: string): Promise<Record<string, unknown>> {
  const content = await getContent(contentId, dataDir);
  if (!content || content.deletedAt) return { ok: false, code: "not_found", error: "这条稿不在了" };
  const active = isVideoPlatform(content.platform) && (await isOntologyActive(dataDir, contentId));
  const exp = await explainContent(content, dataDir);
  const base = { ok: true, id: content.id, title: content.title, platform: content.platform ?? null, status: content.status, active,
    column: exp.column, stage: exp.stage, missing: exp.missing, badges: exp.badges, candidates: exp.candidates };
  if (!active) return base;
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const receipts = publishReceipts(doc);
  const corrected = new Set(doc.decisions.filter((d) => d.type === "publish_correction").map((d) => d.target_id));
  // 新的在前（Codex 审 seg3 P2：「纠正最近一条」要真是最近的那条），每条带时间
  const published = [
    ...doc.decisions.filter((d) => d.round === doc.round && d.type === "i_published" && !corrected.has(d.id)).map((d) => ({ id: d.id, kind: "decision", platform: d.platform ?? null, url: d.note ?? null, label: "你标了已发布", at: d.at })),
    ...receipts.live.map((f) => ({ id: f.id, kind: "receipt", platform: f.platform ?? null, url: f.url ?? null, label: f.evidence ?? "发布回执", at: f.at })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const n = doc.registrations.length;
  const checklistRel = n ? spokenRel(n).replace(/-spoken\.md$/, "-checklist.json") : null;
  const checklist = checklistRel && (await fs.stat(path.join(contentRoot(contentId, dataDir), checklistRel)).then(() => true, () => false)) ? checklistRel : null;
  const cut = validCutApproval(doc, content.body), cover = validCoverApproval(doc, content.body);
  return {
    ...base, round: doc.round,
    pending_receipts: receipts.pending.map((f) => ({ fact_id: f.id, platform: f.platform ?? null, url: f.url ?? f.item_id ?? null, host: f.by?.host ?? "AI" })),
    published,
    approvals: { cut: cut ? { id: cut.id, sha256: cut.sha256 } : null, cover: cover ? { id: cover.id } : null },
    checklist,
    can_reopen: doc.facts.some((f) => f.round === doc.round && f.state === "accepted") || doc.decisions.some((d) => d.round === doc.round && d.type === "script_approval"),
  };
}
