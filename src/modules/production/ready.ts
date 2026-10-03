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

/**
 * 认稿前「等你拍板」只出「稿子写好了」：成片 / 封面审阅要等认稿进了制作段才出（inbox.contentItems）。
 * agent 标「可以审了」或记封面时要明说创始人现在看不到，别让它报「创始人会看到」（2026-10-03 事故）。认稿只归创始人。
 */
export function hiddenUntilScriptApproved(view: { phase: string }, status: string, what: string): string | null {
  if (view.phase !== "writing") return null;
  const how = status === "draft_ready"
    ? "请创始人先在「等你拍板」的「稿子写好了，过一眼」里点「稿子没问题」"
    : "这条稿还没交给创始人认稿：先走审稿把它交到「稿子写好了」，再请创始人点「稿子没问题」";
  return `${what}，但稿子还没认：认稿之前「等你拍板」里不会出现它，创始人现在看不到。${how}，认稿后它会自动出现。不要替创始人认稿，也不要把候选里的导出当成片给创始人确认。`;
}
