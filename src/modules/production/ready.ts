/**
 * 「可以审了」（spec 2026-09-30-review-inbox §7-1）：只有 agent 标。对账自动收的导出不算待审。纯函数。
 */
import type { Fact, ProductionDoc } from "../../storage/production-types.js";

/** 本轮被标过「可以审了」、仍 accepted 且字节没被替换的成片，按标记时间从旧到新 */
export function markedCuts(doc: ProductionDoc): Array<{ fact: Fact; marked_at: string; host?: string }> {
  const out: Array<{ fact: Fact; marked_at: string; host?: string }> = [];
  for (const m of (doc.ready_marks ?? []).filter((x) => x.round === doc.round)) {
    const f = doc.facts.find((x) => x.id === m.fact_id && x.kind === "cut" && x.state === "accepted" && !x.replaced_at && x.sha256 === m.sha256 && x.round === doc.round);
    if (!f) continue;
    const prev = out.find((x) => x.fact.id === f.id);
    if (prev) { if (m.at > prev.marked_at) { prev.marked_at = m.at; prev.host = m.by?.host; } continue; }
    out.push({ fact: f, marked_at: m.at, ...(m.by?.host ? { host: m.by.host } : {}) });
  }
  return out.sort((a, b) => a.marked_at.localeCompare(b.marked_at));
}

export function latestMarkedCut(doc: ProductionDoc): { fact: Fact; marked_at: string; host?: string } | null {
  return markedCuts(doc).at(-1) ?? null;
}
