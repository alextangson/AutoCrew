/**
 * autocrew_draft prepare_final（会审 #1/#3/#5）：生成数字与引文的出处清单、绑定当前稿件指纹、把稿件推到「等你认稿」。
 * 「定了」不在这里——只有创始人在工作台点（src/desktop/draft-handlers.ts）。没出处的项不拦，列给创始人决定。
 * 版本比对与清单落盘在同一把单稿写锁里；状态推进在锁外，带 expectedDraft，期间正文变了就推不过去。
 */
import { transitionStatus, type Content, type ContentTx } from "../storage/local-store.js";
import { draftHash } from "../storage/draft-hash.js";
import { isRealDraft } from "../storage/first-body-guard.js";
import { buildChecklist, locateMapping, normalizeMapping, saveChecklist, type FinalChecklist, type MappingInput } from "../modules/draft/draft-final.js";
import { coverageProblems } from "../modules/draft/draft-finalize.js";
import { currentVersion, workbenchUrl } from "../modules/draft/draft-types.js";
import { fail, withVersion } from "./draft-version.js";
import type { DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;

/**
 * 最近一次 Codex 审稿（验收 10-04）：以前只认「审的就是当前版」，审完 v4 又改成 v5 就报没审过。
 * 现在总报最近一次，并标明审的是第几版、之后改没改过。
 */
export function reviewSummary(c: Content, version: number): Record<string, unknown> {
  const last = c.draftPath?.reviewNotes?.at(-1);
  if (!last) return { version, has_notes: false };
  return { version, has_notes: true, reviewed_version: last.version, current: last.version === version, ...(last.version === version ? {} : { note: `审的是第 ${last.version} 版，之后又改过` }) };
}

async function prepare(a: DraftArgs, c: Content, tx: ContentTx, mapping: MappingInput[]): Promise<R> {
  if (!await isRealDraft(c, a.dataDir)) return fail("empty_body", "还没有正文：先 save 一版再定稿");
  const entries = c.evidenceLedger?.entries ?? [];
  const located = locateMapping(c.body, mapping, entries);
  if (located.errors.length) return fail("bad_citations", "出处映射有错，改好再交", { errors: located.errors });
  const version = currentVersion(c);
  const items = buildChecklist(c.body, located.spans, entries);
  const problems = coverageProblems(c, items);
  if (problems.length) return fail("coverage_invalid", "这份清单交接出处门过不了，创始人点「定了」也会被拒：按 errors 改映射或正文再交", { errors: problems });
  const checklist: FinalChecklist = { draft_hash: draftHash(c), prepared_at: new Date().toISOString(), items, review: reviewSummary(c, version) };
  await saveChecklist(c.id, checklist, a.dataDir);
  await tx.write({ draftPath: { ...c.draftPath!, checklistAt: checklist.prepared_at } });
  return { ok: true, checklist, expected: { title: c.title, body: c.body, platform: c.platform }, status: c.status };
}

export async function draftPrepareFinal(a: DraftArgs): Promise<R> {
  const mapping = normalizeMapping(a.citations);
  if (typeof mapping === "string") return fail("bad_param", mapping);
  const r = await withVersion(a, (c, tx) => prepare(a, c, tx, mapping));
  if (!r.ok) return r;
  const checklist = r.checklist as FinalChecklist;
  if (r.status !== "draft_ready") {
    const moved = await transitionStatus(a.contentId!, "draft_ready", { expectedDraft: r.expected as Content, host: a.host }, a.dataDir);
    if (!moved.ok) return fail("transition_failed", moved.error ?? "没能推到「等你认稿」");
  }
  const unsourced = checklist.items.filter((i) => i.status === "unsourced");
  return {
    ok: true,
    status: "draft_ready",
    items: checklist.items.map((i) => ({ id: i.id, status: i.status, ...(i.kind ? { kind: i.kind } : {}), text: i.text, evidence_ids: i.evidence_ids, ...(i.reason ? { reason: i.reason } : {}), ...(i.needs_human.length ? { needs_human: i.needs_human } : {}) })),
    unsourced: unsourced.length,
    review: checklist.review,
    workbench_url: workbenchUrl(a.contentId!),
    next_action: {
      note: `把链接给创始人，请他在工作台看清单后点「定了」。${unsourced.length ? `有 ${unsourced.length} 处没出处：他可以保留，或让你补出处 / 删掉后重新 prepare_final。` : ""}之后再改正文，这份清单就作废，要重新 prepare_final。`,
    },
  };
}
