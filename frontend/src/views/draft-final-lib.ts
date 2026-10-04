/** 薄路径定稿面板的纯逻辑：「定了」能不能点、不能点时在按钮位置写什么原因 */
export interface DraftItem { id: string; status: "sourced" | "unsourced"; text: string; evidence_ids: string[]; reason?: string; needs_human?: string[] }
export interface DraftVerdict { verdict: "pass" | "fail"; reason: string; quotes?: string[] }
export interface StructuredReview { main_line: DraftVerdict; payoff: DraftVerdict; opening: DraftVerdict; advisories?: Array<{ text: string; quote?: string }> }
export interface DraftReviewNote { version: number; notes: unknown; at: string }
export interface DraftPanelData {
  status: string; draft_hash: string; version: number; review_notes: DraftReviewNote[];
  checklist: { draft_hash: string; items: DraftItem[]; current: boolean } | null;
  finalized: { at: string; current: boolean } | null;
}

export function finalizeBlock(d: DraftPanelData, keep: ReadonlySet<string>, dirty: boolean): string | null {
  if (d.status !== "draft_ready") return null;
  if (dirty) return "先保存修改；保存后要让 agent 重新出清单";
  if (!d.checklist) return "还没有定稿清单：在对话里说「定了」，agent 会先出清单";
  if (!d.checklist.current) return "清单出完之后稿子又改过：让 agent 重新出清单再点";
  const open = d.checklist.items.filter((i) => i.status === "unsourced" && !keep.has(i.id)).length;
  return open ? `还有 ${open} 处没出处：逐条点「保留」，或让 agent 补出处 / 删掉` : null;
}

export const VERDICT_LABEL: Record<string, string> = { main_line: "主线", payoff: "收获", opening: "开头" };

/** 审稿意见是不是按提示词的三项结论结构交的（全形状都对才算；不是就原文展示，不崩） */
export function structuredReview(notes: unknown): StructuredReview | null {
  const n = notes as Record<string, unknown> | null;
  const isStr = (x: unknown) => typeof x === "string";
  const verdict = (v: unknown) => {
    const x = v as Record<string, unknown> | null;
    return Boolean(x && typeof x === "object" && (x.verdict === "pass" || x.verdict === "fail") && isStr(x.reason)
      && (x.quotes === undefined || (Array.isArray(x.quotes) && x.quotes.every(isStr))));
  };
  const advice = (a: unknown) => { const x = a as Record<string, unknown> | null; return Boolean(x && typeof x === "object" && isStr(x.text) && (x.quote === undefined || isStr(x.quote))); };
  if (!n || typeof n !== "object" || !verdict(n.main_line) || !verdict(n.payoff) || !verdict(n.opening)) return null;
  if (n.advisories !== undefined && !(Array.isArray(n.advisories) && n.advisories.every(advice))) return null;
  return n as unknown as StructuredReview;
}
