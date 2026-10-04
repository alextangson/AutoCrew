/** 薄路径定稿面板的纯逻辑：「定了」能不能点、不能点时在按钮位置写什么原因 */
export interface DraftItem { id: string; status: "sourced" | "unsourced"; text: string; evidence_ids: string[]; reason?: string; needs_human?: string[] }
export interface DraftVerdict { verdict: "pass" | "fail"; reason: string; quotes: string[] }
export interface DraftReview {
  status: string; version?: number; current?: boolean; note?: string;
  result?: { main_line: DraftVerdict; payoff: DraftVerdict; opening: DraftVerdict; advisories: Array<{ text: string; quote?: string }> };
  error?: { code: string; message: string; detail?: string };
}
export interface DraftPanelData {
  status: string; draft_hash: string; review: DraftReview;
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
