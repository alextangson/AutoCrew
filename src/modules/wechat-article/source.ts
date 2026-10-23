/**
 * 公众号文章的底稿（全媒体 spec §3.2 第 1 条）：源视频审过的成片的登记字幕（与成片字节绑定），
 * 加上源视频的调研台账。没有登记字幕（旧流程 / 字幕没登记 / 读不了）才退回源视频的定稿正文，并写明为什么——
 * 不悄悄换底稿。
 */
import { getContent, type Content } from "../../storage/local-store.js";
import { registeredPackage } from "../production/publish-gate.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import fs from "node:fs/promises";
import { srtCues } from "../publish/review-gate/subtitles.js";
import type { LedgerEntry } from "../research/evidence-ledger.js";

/** 写长文要整条转写：字数上限放宽到 4 万字（一条 20 分钟口播约 6000 字） */
const TRANSCRIPT_BUDGET = 40_000;

export interface ArticleSource {
  kind: "srt" | "script";
  text: string;
  /** 给创始人和写手看的说明：底稿从哪来；退回定稿正文时写原因 */
  note: string;
  ledger: Array<Pick<LedgerEntry, "id" | "source" | "claim" | "quote" | "sourceUrl">>;
}

export type SourceResult = { ok: true; source: ArticleSource; sourceId: string } | { ok: false; code: string; error: string };

export async function articleSource(article: Pick<Content, "derivedFrom">, dataDir: string): Promise<SourceResult> {
  const from = article.derivedFrom;
  if (from?.kind !== "wechat_article") return { ok: false, code: "not_derived_article", error: "这条不是由视频派生的公众号文章" };
  const src = await getContent(from.contentId, dataDir).catch(missingAsNull);
  if (!src || src.deletedAt) return { ok: false, code: "source_missing", error: `源视频（${from.contentId}）不在了：没有底稿可写` };
  const { srt, why } = await registeredSrt(src, dataDir);
  const full = srt ? await loadFullSrt(srt) : null;
  const ledger = ledgerOf(src);
  if (full && "text" in full) return { ok: true, sourceId: src.id, source: { kind: "srt", text: full.text, note: "底稿 = 源视频审过的成片的登记字幕", ledger } };
  const reason = full && "error" in full ? `登记字幕读不了（${full.error}）` : why ?? "没有登记字幕";
  return { ok: true, sourceId: src.id, source: { kind: "script", text: src.body ?? "", note: `底稿 = 源视频的定稿正文（不是成片转写）：${reason}`, ledger } };
}

async function registeredSrt(src: Content, dataDir: string): Promise<{ srt: string | null; why?: string }> {
  const g = await registeredPackage(src, dataDir, { fresh: true }).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  if (!g) return { srt: null, why: "源视频走的是旧流程，没有登记字幕" };
  if (!g.ok) return { srt: null, why: `成片登记读不出来（${g.error}）` };
  return g.files.srt ? { srt: g.files.srt } : { srt: null, why: "这版成片没有登记字幕" };
}

/** 字幕全文（不按 Jev 比对预算截断）；读不了或是空的交回原因 */
async function loadFullSrt(srtPath: string): Promise<{ text: string } | { error: string }> {
  try {
    const text = srtCues(await fs.readFile(srtPath, "utf8")).map((c) => c.text).join("\n");
    if (!text.trim()) return { error: "字幕是空的" };
    return { text: text.length > TRANSCRIPT_BUDGET ? text.slice(0, TRANSCRIPT_BUDGET) : text };
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
  }
}

function ledgerOf(src: Content): ArticleSource["ledger"] {
  return (src.evidenceLedger?.entries ?? []).map((e) => ({ id: e.id, source: e.source, claim: e.claim, quote: e.quote, sourceUrl: e.sourceUrl }));
}

/** 写进写作要求的那一块：底稿说明 + 全文 + 台账（只有台账里的条目能当出处，新引文先过 verify_quote） */
export const SOURCE_BLOCK_HEAD = "【公众号长文底稿——由源视频改写】";

export function renderArticleSource(s: ArticleSource): string {
  const ledger = s.ledger.length
    ? s.ledger.map((e) => `- [${e.id}]（${e.source}）${e.claim ? `${e.claim}：` : ""}「${e.quote}」${e.sourceUrl ? ` ${e.sourceUrl}` : ""}`).join("\n")
    : "（源视频没有调研台账条目）";
  return [
    SOURCE_BLOCK_HEAD,
    `底稿来源：${s.note}`,
    "规则：观点、案例、数字只用底稿和下面台账里有的；要补新材料走 autocrew_scout，新引文必须先 verify_quote 通过才能写进正文。",
    "--- 底稿全文 ---",
    s.text,
    "--- 源视频调研台账 ---",
    ledger,
  ].join("\n");
}
