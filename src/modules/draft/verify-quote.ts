/**
 * verify_quote（再收窄 #3）：抓网页、逐字比对，过了才记进这篇的证据台账（Content.evidenceLedger）并返回编号。
 * 不存抓取快照：每次现抓。比对口径与 research-broker.validateQuote 相同（quoteCorpus：消毒 + 空白归一）；
 * 台账只存真正比对过的那段文字（引文被消毒改动过就拒，不能借 [链接] 替换夹带内容）。
 */
import { fetchExternalPage, type ExternalPage } from "../inbox/fetch-external.js";
import { normalizeWhitespace, quoteCorpus } from "../research/research-broker.js";
import { restoreEvidenceLedger, type EvidenceLedgerSnapshot, type LedgerEntry } from "../research/evidence-ledger.js";
import { contentTransaction } from "../../storage/local-store.js";

type Fetch = (url: string) => Promise<ExternalPage>;
let fetchOverride: Fetch | undefined;
/** 只给测试：替换真实抓页 */
export function setQuoteFetch(fn: Fetch | undefined): void { fetchOverride = fn; }

const EMPTY: EvidenceLedgerSnapshot = { entries: [], lookups: [], budget: { max: 0, used: 0 } };

function nextEvidenceId(entries: readonly LedgerEntry[]): string {
  const max = entries.reduce((m, e) => Math.max(m, Number(/^ev-d(\d+)$/.exec(e.id)?.[1] ?? 0)), 0);
  return `ev-d${max + 1}`;
}

export type VerifyResult = { ok: true; evidence_id: string; duplicate: boolean; final_url: string } | { ok: false; code: string; error: string };

export async function verifyQuote(contentId: string, url: string, quote: string, claim: string | undefined, dataDir?: string): Promise<VerifyResult> {
  let page: ExternalPage;
  try { page = await (fetchOverride ?? ((u: string) => fetchExternalPage(u)))(url); }
  catch (err) { return { ok: false, code: "fetch_failed", error: `网页没抓下来：${err instanceof Error ? err.message : String(err)}` }; }
  // 比对语料会把链接等替换成 [链接]：引文自己被替换过，就说明有一段没真正比对——那段可能夹带任何文字，整条拒
  const plain = normalizeWhitespace(quote);
  const needle = quoteCorpus(quote);
  if (!needle) return { ok: false, code: "bad_param", error: "quote 不能为空" };
  if (needle !== plain) return { ok: false, code: "quote_unverifiable", error: "引文里带了链接或会被过滤的内容，没法逐字核对：只复制正文里的文字，不要带网址" };
  if (!quoteCorpus(page.text).includes(needle)) {
    return { ok: false, code: "quote_not_found", error: `这段在 ${page.finalUrl} 的正文里找不到：从原网页逐字复制一段 15–60 字的原句，不能转述或改写` };
  }
  const sourceUrl = page.finalUrl || url;
  // 台账读-改-写在稿件写锁里完成，两次同时登记不会互相覆盖
  return contentTransaction(contentId, dataDir, async (tx) => {
    const content = await tx.read();
    if (!content) return { ok: false, code: "not_found", error: `稿件不存在：${contentId}` };
    const ledger = restoreEvidenceLedger(content.evidenceLedger ?? EMPTY);
    const same = ledger.entries().find((e) => e.sourceUrl === sourceUrl && e.quote === plain);
    if (same) return { ok: true, evidence_id: same.id, duplicate: true, final_url: sourceUrl };
    const entry = ledger.add({ id: nextEvidenceId(ledger.entries()), source: "verified_quote", quote: plain, sourceUrl, ...(claim?.trim() ? { claim: claim.trim() } : {}) });
    await tx.write({ evidenceLedger: ledger.snapshot() });
    return { ok: true, evidence_id: entry.id, duplicate: false, final_url: sourceUrl };
  });
}
