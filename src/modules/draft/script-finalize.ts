/**
 * 稿件页顶栏「定稿」（视频稿，2026-10-26）：不管 AI 是不是还占着、状态是不是还在写稿中，创始人看过就能定。
 * 只由浏览器会话调（入口在 desktop/draft-handlers 判认证方式）。一次落盘做三件事：
 * 释放写手认领（照 handoff revoke 的做法清掉认领、记一笔交接账）→ 推到「等 A-roll」（approved）→
 * 由现有的创始人流转写认稿决定（production-hooks，绑正文哈希）。
 * 薄路径（autocrew_draft）不等出处清单：清单对得上就把没出处的项全记成未核验（同「定了」的保留语义），
 * 没清单 / 清单是旧稿的就照定，并在 draftFinal 上记下来——交接出处门照旧把关，这里不替它放行。
 */
import { draftHash } from "../../storage/draft-hash.js";
import { contentTransaction, getContent, getDataDir, LOCAL_HOST, transitionStatus, withHandoff, type Content, type ContentStatus, type ContentUpdates } from "../../storage/local-store.js";
import { bodyHash, readProductionDoc, scriptApprovalFor } from "../../storage/production-store.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { saveCoverage, type CitationCoverage } from "../video/handoff/project-evidence.js";
import { loadChecklist, type FinalChecklist } from "./draft-final.js";
import { citationsFor, withKeptEntries } from "./draft-finalize.js";

type R = Record<string, unknown>;
const fail = (code: string, error: string): R => ({ ok: false, code, error });

/** 还在写稿段：这些状态下顶栏给「定稿」按钮；approved 及之后只显示「已定稿」 */
export const WRITING_PHASE: ReadonlySet<ContentStatus> = new Set(["topic_saved", "drafting", "needs_evidence", "draft_ready", "reviewing", "revision"]);

const inScope = (c: Content) => isVideoPlatform(c.platform) && !c.derivedFrom && c.source !== "imported_history";

/** 薄路径的出处清单状态：current = 绑的就是现在这版稿 */
async function checklistOf(c: Content, dataDir?: string): Promise<{ list: FinalChecklist | null; current: boolean }> {
  if (!c.draftPath) return { list: null, current: false };
  const list = await loadChecklist(c.id, dataDir);
  return { list, current: Boolean(list && list.draft_hash === draftHash(c)) };
}

/** 清单对得上：没出处的全记成未核验进台账，连同已核验的引文写 citations.json（交接出处门要的那份） */
async function recordCoverage(c: Content, list: FinalChecklist, dataDir?: string): Promise<string | null> {
  const kept = list.items.filter((i) => i.status === "unsourced");
  const merged = await contentTransaction(c.id, dataDir, async (tx) => {
    const cur = await tx.read();
    if (!cur) return null;
    const { entries, keptIds } = withKeptEntries(cur, kept);
    const updated = await tx.write({ evidenceLedger: { ...(cur.evidenceLedger ?? { lookups: [], budget: { max: 0, used: 0 } }), entries } });
    return updated ? { updated, entries, keptIds } : null;
  });
  if (!merged) return `稿件不存在：${c.id}`;
  const { updated, entries, keptIds } = merged;
  const coverage: CitationCoverage = { draft_hash: draftHash(updated), citations: citationsFor(updated.body, list.items, entries, keptIds), reviewed_by: "founder-workbench", reviewed_at: new Date().toISOString() };
  try { await saveCoverage(updated, coverage, getDataDir(dataDir)); return null; }
  catch (err) { return `出处映射没写进去：${err instanceof Error ? err.message : String(err)}`; }
}

/** 和状态同一次落盘的补丁：清掉写手认领（记账）、薄路径盖 draftFinal */
function finalizePatch(c: Content, check: { list: FinalChecklist | null; current: boolean }, at: string) {
  return (cur: Content): ContentUpdates => {
    const out: ContentUpdates = {};
    if (cur.claim) {
      out.claim = undefined;
      out.handoffs = withHandoff(cur, { from: cur.claim.host, to: LOCAL_HOST, by: LOCAL_HOST, note: "创始人定稿，写手认领释放" });
    }
    if (c.draftPath) {
      const kept = check.current ? check.list!.items.filter((i) => i.status === "unsourced").map((i) => i.id) : [];
      out.draftFinal = {
        draftHash: draftHash(c), finalizedAt: at, source: "founder-workbench", kept,
        ...(check.current ? {} : { checklist: check.list ? "stale" as const : "none" as const }),
        ...(cur.draftPath?.angle?.playbook ? { playbook: cur.draftPath.angle.playbook } : {}),
      };
    }
    return out;
  };
}

export async function finalizeScript(contentId: string, input: { expectedBodyHash: string }, dataDir?: string): Promise<R> {
  const c = await getContent(contentId, dataDir);
  if (!c) return fail("not_found", `稿件不存在：${contentId}`);
  if (!inScope(c)) return fail("not_video", "这篇不是视频口播稿，按原来的流程走");
  const doc = await readProductionDoc(c.id, dataDir);
  if (doc && scriptApprovalFor(doc, c.body) && !WRITING_PHASE.has(c.status)) return { ok: true, already: true, status: c.status };
  if (!WRITING_PHASE.has(c.status)) return fail("wrong_status", "这篇已经过了写稿段：要重新定，先在「更多」里撤回定稿");
  if (!input.expectedBodyHash || input.expectedBodyHash !== bodyHash(c.body)) return fail("body_changed", "页面上的稿和存着的不一样（别处刚改过）：刷新看一眼再定");
  const check = await checklistOf(c, dataDir);
  if (check.list && check.current) {
    const err = await recordCoverage(c, check.list, dataDir);
    if (err) return fail("citations_invalid", err);
  }
  const moved = await transitionStatus(c.id, "approved", {
    force: true, expectedStatus: c.status, expectedBodyHash: input.expectedBodyHash,
    decidedBy: "founder", host: LOCAL_HOST, patch: finalizePatch(c, check, new Date().toISOString()),
  }, dataDir);
  if (!moved.ok) return fail("transition_failed", moved.error ?? "没能定稿");
  return { ok: true, status: "approved" };
}

/** 顶栏读的那一份：在不在范围、认稿时刻、薄路径还剩几处没核出处 */
export async function finalState(contentId: string, dataDir?: string): Promise<R> {
  const c = await getContent(contentId, dataDir);
  if (!c) return fail("not_found", `稿件不存在：${contentId}`);
  if (!inScope(c)) return { ok: true, data: null };
  const doc = await readProductionDoc(c.id, dataDir);
  const approval = doc ? scriptApprovalFor(doc, c.body) : null;
  const check = await checklistOf(c, dataDir);
  const gaps = !c.draftPath ? null
    : check.list && check.current ? { kind: "unsourced" as const, count: check.list.items.filter((i) => i.status === "unsourced").length }
      : { kind: check.list ? "stale" as const : "none" as const, count: 0 };
  return { ok: true, data: { status: c.status, approved_at: approval?.at ?? null, writing: WRITING_PHASE.has(c.status), gaps } };
}
