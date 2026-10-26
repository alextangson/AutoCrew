/**
 * 公众号文章的底稿（全媒体 spec §3.2 第 1 条）：源视频审过的成片的登记字幕（与成片字节绑定），
 * 加上源视频的调研台账。没有登记字幕（旧流程 / 字幕没登记 / 读不了）才退回源视频的定稿正文，并写明为什么——
 * 不悄悄换底稿。
 */
import { getContent, type Content } from "../../storage/local-store.js";
import { createHash } from "node:crypto";
import { ontologyApplies } from "../production/publish-gate.js";
import { srtFor, validCutApproval } from "../production/derive.js";
import { factPath } from "../production/chat-approval/files.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { resolveArchivedFile } from "../../storage/nas-kept.js";
import { contentRoot } from "../../storage/content-project.js";
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

export const LEGACY_IMPORT_NOTE = "这条老视频没登记成片字幕，底稿用的是定稿正文；成片剪辑时删改过的内容可能还在";

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
  return { ok: true, sourceId: src.id, source: { kind: "script", text: src.body ?? "", note: reason === LEGACY_IMPORT_NOTE ? reason : `底稿 = 源视频的定稿正文（不是成片转写）：${reason}`, ledger } };
}

/**
 * 审过的那版成片绑定的字幕（只看成片批准，不等封面——封面和文章是并行做的）。
 * 字幕文件的字节要和登记时的 sha256 对上，对不上就当没有，原因写明。
 */
async function registeredSrt(src: Content, dataDir: string): Promise<{ srt: string | null; why?: string }> {
  if (!(await ontologyApplies(src, dataDir))) return { srt: null, why: "源视频走的是旧流程，没有登记字幕" };
  const doc = await readProductionDocOrEmpty(src.id, dataDir);
  const cut = validCutApproval(doc, src.body ?? "");
  // 从旧流程导入的老视频（有 videoDone、本体里从没审过片）：本来就没登记过成片字幕，照实说
  if (!cut?.sha256 && src.videoDone && !doc.decisions.some((d) => d.type === "cut_approval" || d.type === "cut_reject")) return { srt: null, why: LEGACY_IMPORT_NOTE };
  if (!cut?.sha256) return { srt: null, why: "源视频的成片现在没有有效的审片通过" };
  const fact = srtFor(doc, cut.sha256);
  if (!fact?.path) return { srt: null, why: "审过的这版成片没有登记字幕" };
  // 源视频归档了：读本机留底的字幕副本，或 NAS 上的（没挂就明说，不悄悄退回定稿正文）
  const found = await resolveArchivedFile(factPath(src.id, fact, dataDir), contentRoot(src.id, dataDir));
  if (!found.ok) return { srt: null, why: `登记字幕${found.error}` };
  const file = found.path;
  try {
    const sha = createHash("sha256").update(await fs.readFile(file)).digest("hex");
    return sha === fact.sha256 ? { srt: file } : { srt: null, why: "字幕文件在登记之后被改过" };
  } catch (e) {
    return { srt: null, why: `登记字幕读不了（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）` };
  }
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

/** 源视频的条目编号加命名空间（src:<源视频 id>:<原编号>），和本文自己的 ev-1 / user-research 不会撞号 */
function ledgerOf(src: Content): ArticleSource["ledger"] {
  return (src.evidenceLedger?.entries ?? []).map((e) => ({ id: `src:${src.id}:${e.id}`, source: e.source, claim: e.claim, quote: e.quote, sourceUrl: e.sourceUrl }));
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
