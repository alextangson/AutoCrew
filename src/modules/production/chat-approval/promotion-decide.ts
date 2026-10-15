/**
 * 改稿意见升级成范文批注 / 写法（spec 2026-10-15 §6、§15.8）在「等你拍板」里：批 / 不要。
 * 批了只标「已批、等人工改」：不自动改范文文件，也不自动改技能里的写法（那要随代码发布）。
 */
import { genOf } from "../inbox.js";
import { decidePromotion, readPromotions, type Promotion } from "../../exemplar/promotions.js";
import { ExemplarError } from "../../exemplar/types.js";
import type { InboxItem } from "../inbox.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });

export const PROMOTION_DECISIONS: ReadonlySet<string> = new Set(["approve_promotion", "reject_promotion"]);
const TARGET_NAME = { exemplar: "给范文加一条批注", method: "改「写法」里的一条" } as const;

function promotionItem(p: Promotion): InboxItem {
  const item_id = `promotion:${p.id}`;
  return { item_id, gen: genOf([item_id, p.gen]), type: "writing_promotion", content_id: null, title: `改稿意见升级：${TARGET_NAME[p.target]}`, summary: p.reason,
    waiting: null, agent_waiting: false, since: p.at, rank: 4, actions: [],
    detail: { where: "writing-promotions", promotion_id: p.id, promotion_gen: p.gen, target: p.target, exemplar_id: p.exemplar_id ?? null, text: p.text, reason: p.reason, cites: p.cites } };
}

/** 待批的升级提案；文件读坏了列一件看得见的「其他」，不当成没有 */
export async function promotionItems(dataDir: string): Promise<InboxItem[]> {
  try {
    return (await readPromotions(dataDir)).filter((p) => p.status === "pending").map(promotionItem);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [{ item_id: "promotion:error", gen: genOf(["promotion:error", msg]), type: "other", content_id: null, title: "改稿意见升级提案读不了", summary: msg,
      waiting: null, agent_waiting: false, since: new Date(0).toISOString(), rank: 4, actions: [], detail: { error: msg } }];
  }
}

export function promotionFacts(item: InboxItem): Record<string, unknown> {
  const d = item.detail;
  return { promotion_id: d.promotion_id, target: d.target, exemplar_id: d.exemplar_id, text: d.text, reason: d.reason, cites: d.cites };
}

export function promotionBrief(item: InboxItem): string {
  const d = item.detail;
  const cites = (d.cites as Array<{ content_id: string; index: number; founder_words: string }>).map((c) => `- 稿 ${c.content_id} 第 ${c.index} 条：「${c.founder_words}」`);
  return [
    `改稿意见升级提案：${TARGET_NAME[d.target as Promotion["target"]]}${d.exemplar_id ? `（范文 ${String(d.exemplar_id)}）` : ""}`,
    `为什么：${String(d.reason)}`,
    "你在两篇不同的稿里说过：", ...cites,
    "要改成：", String(d.text),
    "批了也不会自动改：先记成「已批、等人工改」，改好了才生效。",
    "回我「批」/「不要」",
  ].join("\n");
}

export async function promotionCommit(item: InboxItem, decision: string, founderWords: string, dataDir: string): Promise<Result> {
  try {
    const p = await decidePromotion(String(item.detail.promotion_id), String(item.detail.promotion_gen), decision === "reject_promotion" ? "reject" : "approve", founderWords, dataDir);
    const done = p.status === "rejected" ? "这条升级不要了，同一段以后不再提" : "记成「已批、等人工改」：范文 / 写法还没变，要有人照着改好才生效";
    return { ok: true, decision, promotion_id: p.id, status: p.status, recorded_as: "chat", next_action: `告诉创始人：${done}。` };
  } catch (e) {
    if (e instanceof ExemplarError) return fail(e.code === "not_found" ? "already_handled" : e.code, e.message);
    throw e;
  }
}
