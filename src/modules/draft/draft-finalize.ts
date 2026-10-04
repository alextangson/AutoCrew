/**
 * 创始人在工作台点「定了」（会审 #1/#2/#3）。只由浏览器会话调（入口在 desktop/draft-handlers 判认证方式）。
 * 核对清单绑定的稿件指纹 → 没出处的项必须都被创始人保留 → 保留项写成显式的「未核验引用」（user_claim）进台账，
 * 连同已核验的引文写 citations.json（交接出处门要的那份）→ 推进到「等 A-roll」（approved），
 * 由现有的创始人流转写认稿决定（production-hooks），并在同一次落盘盖 draftFinal。
 */
import { draftHash } from "../../storage/draft-hash.js";
import { contentTransaction, getContent, getDataDir, LOCAL_HOST, transitionStatus, type Content } from "../../storage/local-store.js";
import { restoreEvidenceLedger, type LedgerEntry } from "../research/evidence-ledger.js";
import { CREATOR_EVIDENCE_ID, CREATOR_OPINION, saveCoverage, validateCoverage, type Citation, type CitationCoverage } from "../video/handoff/project-evidence.js";
import { factualSentences } from "../video/handoff/factual-sentences.js";
import { currentVersion } from "./draft-types.js";
import { loadChecklist, type ChecklistItem, type FinalChecklist } from "./draft-final.js";

type R = Record<string, unknown>;
const fail = (code: string, error: string, extra: R = {}): R => ({ ok: false, code, error, ...extra });
export const KEPT_REASON = "创始人在工作台定稿时保留，未核验";

/** 保留项写成 user_claim 条目（编号按清单项稳定生成，重复点幂等） */
function withKeptEntries(c: Content, items: ChecklistItem[]): { entries: LedgerEntry[]; keptIds: Map<string, string> } {
  const ledger = restoreEvidenceLedger(c.evidenceLedger ?? { entries: [], lookups: [], budget: { max: 0, used: 0 } });
  const keptIds = new Map<string, string>();
  for (const item of items) {
    const id = `user-kept-${item.id.split(":").pop()}`;
    ledger.add({ id, source: "user_claim", quote: item.text, claim: item.text, reason: KEPT_REASON });
    keptIds.set(item.id, id);
  }
  return { entries: [...ledger.entries()], keptIds };
}

function ledgerCitations(body: string, at: { start: number; end: number }, ids: string[], byId: Map<string, LedgerEntry>): Citation[] {
  return ids.map((id) => {
    const e = byId.get(id)!;
    return {
      start: at.start, end: at.end, excerpt: body.slice(at.start, at.end), evidence_id: id, sourceType: e.source,
      ...(e.sourceUrl ? { sourceUrl: e.sourceUrl } : {}), quote: e.quote,
      verification: e.source === "verified_quote" ? "引文逐字出自抓回的原网页（autocrew_draft cite 已核）" : `未核验：${KEPT_REASON}`,
    };
  });
}

/** 不需要出处的句子（示意 / 判断，或只有相对时间、约数）：交接出处门仍要每个事实句有定位，记成创作者自己的话，标明为什么不需要出处 */
const creatorCitation = (body: string, at: { start: number; end: number }, why: string): Citation => ({
  start: at.start, end: at.end, excerpt: body.slice(at.start, at.end), evidence_id: CREATOR_EVIDENCE_ID, sourceType: CREATOR_OPINION, quote: "", verification: `不需要出处：${why}`,
});
const EXEMPT_WHY = { example: "类比 / 示意例子（agent 标注）", judgment: "我们自己的判断（agent 标注）" } as const;

function citationsFor(body: string, items: ChecklistItem[], entries: readonly LedgerEntry[], keptIds: Map<string, string>): Citation[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out = items.flatMap((item) => {
    if (item.status === "exempt") return item.evidence_ids.length ? ledgerCitations(body, item, item.evidence_ids, byId) : [creatorCitation(body, item, EXEMPT_WHY[item.kind ?? "example"])];
    return ledgerCitations(body, item, item.status === "sourced" ? item.evidence_ids : [keptIds.get(item.id)!], byId);
  });
  for (const s of factualSentences(body)) {
    if (!out.some((c) => c.start <= s.start && c.end >= s.end)) out.push(creatorCitation(body, s, "只有相对时间或约数，没有具体数字"));
  }
  return out;
}

/**
 * prepare_final 先按「没出处的全保留」把交接出处门预演一遍（Codex review P2）：
 * 清单看着能定、点「定了」却被出处门拒，这种情况在出清单时就要报出来。
 */
export function coverageProblems(c: Content, items: ChecklistItem[]): string[] {
  const { entries, keptIds } = withKeptEntries(c, items.filter((i) => i.status === "unsourced"));
  const simulated = { ...c, evidenceLedger: { ...(c.evidenceLedger ?? { lookups: [], budget: { max: 0, used: 0 } }), entries } } as Content;
  const coverage: CitationCoverage = { draft_hash: draftHash(simulated), citations: citationsFor(c.body, items, entries, keptIds), reviewed_by: "preflight", reviewed_at: new Date().toISOString() };
  return validateCoverage(simulated, coverage);
}

async function checkReady(c: Content, checklist: FinalChecklist | null, hash: string, keep: string[]): Promise<R | null> {
  if (!c.draftPath) return fail("not_draft_path", "这篇不是用 autocrew_draft 写的，按原来的认稿流程走");
  if (c.status !== "draft_ready") return fail("wrong_status", "稿子不在「等你认稿」：让 agent 先 prepare_final");
  if (!checklist) return fail("no_checklist", "还没有定稿清单：让 agent 先 prepare_final");
  const current = draftHash(c);
  if (checklist.draft_hash !== current || hash !== current) return fail("stale_checklist", "清单生成之后稿子改过了：这个「定了」作废，让 agent 重新 prepare_final");
  const missing = checklist.items.filter((i) => i.status === "unsourced" && !keep.includes(i.id));
  if (missing.length) return fail("unsourced_open", `还有 ${missing.length} 处没出处：逐条点「保留」，或让 agent 补出处 / 删掉后重新 prepare_final`, { items: missing.map((i) => i.id) });
  return null;
}

export async function finalizeByFounder(contentId: string, input: { draftHash: string; keep: string[] }, dataDir?: string): Promise<R> {
  const c = await getContent(contentId, dataDir);
  if (!c) return fail("not_found", `稿件不存在：${contentId}`);
  if (c.status === "approved" && c.draftFinal?.draftHash === draftHash(c)) return { ok: true, already: true, status: "approved" };
  const checklist = await loadChecklist(contentId, dataDir);
  const blocked = await checkReady(c, checklist, input.draftHash, input.keep);
  if (blocked) return blocked;
  const kept = checklist!.items.filter((i) => i.status === "unsourced");
  // 台账读-并-写在同一把单稿写锁里：期间别的写入（verify_quote 新登记的证据）不会被旧快照盖掉
  const merged = await contentTransaction(c.id, dataDir, async (tx) => {
    const cur = await tx.read();
    if (!cur) return null;
    const { entries, keptIds } = withKeptEntries(cur, kept);
    const updated = await tx.write({ evidenceLedger: { ...(cur.evidenceLedger ?? { lookups: [], budget: { max: 0, used: 0 } }), entries } });
    return updated ? { updated, entries, keptIds } : null;
  });
  if (!merged) return fail("not_found", `稿件不存在：${contentId}`);
  const { updated, entries, keptIds } = merged;
  const coverage: CitationCoverage = { draft_hash: draftHash(updated), citations: citationsFor(updated.body, checklist!.items, entries, keptIds), reviewed_by: "founder-workbench", reviewed_at: new Date().toISOString() };
  try { await saveCoverage(updated, coverage, getDataDir(dataDir)); }
  catch (err) { return fail("citations_invalid", `出处映射没写进去：${err instanceof Error ? err.message : String(err)}`); }
  const at = new Date().toISOString();
  const moved = await transitionStatus(c.id, "approved", {
    force: true, expectedStatus: "draft_ready", expectedDraft: { title: c.title, body: c.body, platform: c.platform },
    decidedBy: "founder", host: LOCAL_HOST,
    patch: { draftFinal: { draftHash: draftHash(c), finalizedAt: at, source: "founder-workbench", kept: kept.map((i) => i.id) } },
  }, dataDir);
  if (!moved.ok) return fail("transition_failed", moved.error ?? "没能推进到等 A-roll");
  return { ok: true, status: "approved", kept: kept.length };
}

/** 工作台读的那一份：清单、是否还对得上当前稿、agent 附的审稿意见（按版本） */
export async function finalPanel(contentId: string, dataDir?: string): Promise<R> {
  const c = await getContent(contentId, dataDir);
  if (!c?.draftPath) return { ok: true, data: null };
  const checklist = await loadChecklist(contentId, dataDir);
  const hash = draftHash(c);
  return {
    ok: true,
    data: {
      status: c.status, draft_hash: hash, version: currentVersion(c), review_notes: c.draftPath.reviewNotes ?? [],
      checklist: checklist ? { ...checklist, current: checklist.draft_hash === hash } : null,
      finalized: c.draftFinal ? { at: c.draftFinal.finalizedAt, current: c.draftFinal.draftHash === hash } : null,
    },
  };
}
