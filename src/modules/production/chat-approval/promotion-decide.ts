/**
 * 改稿意见升级成范文批注 / 写法（spec 2026-10-15 §6、§15.8）在「等你拍板」里：批 / 不要。
 * 批范文批注 = 生成范文新版本；批写法 = 资料库里出一份补丁，条目留在列表里显示「已批，等发布」（只能看，不在对话里定），
 * 技能文件里有合入证据后自动转 released、从列表消失。
 */
import { genOf } from "../inbox.js";
import { decidePromotion, readPromotions, releaseFoldedPromotions, type Promotion } from "../../exemplar/promotions.js";
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

/** 写法改动批了还没发布：一直挂着，看得见，不能在对话里再定 */
function releaseItem(p: Promotion): InboxItem {
  const item_id = `promotion-release:${p.id}`;
  return { item_id, gen: genOf([item_id, p.decided_at]), type: "other", content_id: null, title: "写法改动已批，等发布", summary: `${p.reason}（补丁：${String(p.patch_file)}）`,
    waiting: null, agent_waiting: false, since: p.decided_at ?? p.at, rank: 4, actions: [], detail: { promotion_id: p.id, patch_file: p.patch_file, status: "已批，等发布" } };
}

/** 待批的升级提案；文件读坏了列一件看得见的「其他」，不当成没有 */
export async function promotionItems(dataDir: string, skillFile?: string): Promise<InboxItem[]> {
  try {
    await releaseFoldedPromotions(dataDir, skillFile);
    const all = await readPromotions(dataDir);
    return [...all.filter((p) => p.status === "pending").map(promotionItem), ...all.filter((p) => p.status === "approved_pending_release").map(releaseItem)];
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
    d.target === "exemplar" ? "批了会给这篇范文生成新版本（批注加在末尾）；已经在写的稿仍用它锁住的旧版本。" : "批了不会直接改技能：在资料库出一份补丁，显示「已批，等发布」，随代码发布后才生效。",
    "回我「批」/「不要」",
  ].join("\n");
}

export async function promotionCommit(item: InboxItem, decision: string, founderWords: string, dataDir: string): Promise<Result> {
  try {
    const p = await decidePromotion(String(item.detail.promotion_id), String(item.detail.promotion_gen), decision === "reject_promotion" ? "reject" : "approve", founderWords, dataDir);
    const done = p.status === "rejected" ? "这条升级不要了，同一段以后不再提"
      : p.status === "applied" ? `范文 ${String(p.exemplar_id)} 更新到第 ${String(p.exemplar_version)} 版，之后新出的立意用它`
      : `补丁在资料库 ${String(p.patch_file)}，显示「已批，等发布」，随代码发布后才生效`;
    return { ok: true, decision, promotion_id: p.id, status: p.status, ...(p.exemplar_version ? { exemplar_version: p.exemplar_version } : {}), ...(p.patch_file ? { patch_file: p.patch_file } : {}), recorded_as: "chat", next_action: `告诉创始人：${done}。` };
  } catch (e) {
    if (e instanceof ExemplarError) return fail(e.code === "not_found" ? "already_handled" : e.code, e.message);
    throw e;
  }
}
