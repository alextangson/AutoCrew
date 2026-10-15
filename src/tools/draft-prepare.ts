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
import { pendingLessons } from "../modules/draft/draft-feedback.js";
import { fail, withVersion } from "./draft-version.js";
import { bodyHash } from "../modules/draft/draft-types.js";
import type { DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;

/**
 * 最近一次观众试读（spec 2026-10-15 §15.12）：带类型、状态和被读正文的 hash；对应的是旧版本就写明。
 * 失败 / 不支持不算「已审」。旧稿只有 Codex 审稿的，照旧报最近一次。
 */
export function reviewSummary(c: Content, version: number): Record<string, unknown> {
  const read = c.draftPath?.testReads?.at(-1);
  if (read) {
    const current = read.body_hash === bodyHash(c.body ?? "");
    return { version, kind: "viewer_test_read", status: read.status, reviewed: read.status === "ok", read_version: read.version, current,
      ...(current ? {} : { note: "这是修改前那版的试读" }), ...(read.status === "ok" ? {} : { note_status: read.status === "failed" ? "试读失败，不算已审" : "这个宿主做不了试读，不算已审" }) };
  }
  const last = c.draftPath?.reviewNotes?.at(-1);
  if (!last) return { version, has_notes: false, reviewed: false };
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
  return { ok: true, checklist, expected: { title: c.title, body: c.body, platform: c.platform }, status: c.status, feedback: c.draftPath?.feedback };
}

/** 这篇攒下的待批规则：读档案失败不挡定稿清单，但回执带原始错误（不静默） */
async function lessonsOf(contentId: string, feedback: Parameters<typeof pendingLessons>[1], dataDir?: string): Promise<R> {
  try {
    return await pendingLessons(contentId, feedback, dataDir);
  } catch (err) {
    return { pending_lessons: [], lessons_error: `读不了档案里这篇攒下的待批规则：${err instanceof Error ? err.message : String(err)}。如实告诉创始人` };
  }
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
  const lessons = await lessonsOf(a.contentId!, r.feedback as Parameters<typeof pendingLessons>[1], a.dataDir);
  return {
    ...lessons,
    ok: true,
    status: "draft_ready",
    items: checklist.items.map((i) => ({ id: i.id, status: i.status, ...(i.kind ? { kind: i.kind } : {}), text: i.text, evidence_ids: i.evidence_ids, ...(i.reason ? { reason: i.reason } : {}), ...(i.needs_human.length ? { needs_human: i.needs_human } : {}) })),
    unsourced: unsourced.length,
    review: checklist.review,
    workbench_url: workbenchUrl(a.contentId!),
    next_action: {
      note: `把链接给创始人，请他在工作台看清单后点「定了」。再用 feedback_history 把这篇的意见和别的稿比：同一个意思在另一篇不同的稿里也出现过，才 propose_promotion（只在这篇出现的不提）。${(lessons.pending_lessons as unknown[]).length ? `同一条消息里把 pending_lessons 按编号列给他（有 conflicts_with 的两条并排），附现在生效 ${String(lessons.active_rule_count)} / ${String(lessons.rule_cap)} 条，请他回哪几条要 / 不要 / 替换第几条；他回了就逐条 autocrew_review_inbox decide，没回就不管。` : ""}${(lessons.repeated_rules as unknown[] | undefined)?.length ? "repeated_rules 里的规则早就有了，这次他又提：告诉他「这条已有，说明它没管住」。" : ""}${unsourced.length ? `有 ${unsourced.length} 处没出处：他可以保留，或让你补出处 / 删掉后重新 prepare_final。` : ""}之后再改正文，这份清单就作废，要重新 prepare_final。`,
    },
  };
}
