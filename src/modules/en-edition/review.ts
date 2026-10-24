/**
 * 英文版脚本的审阅状态（Phase 3）：脚本、能当出处的台账、还差什么、脚本指纹、批准还有没有效、源成片是否过期。
 * 审阅页、「等你拍板」认稿那件、认稿决定、配音都读这一份。
 * 认稿 = 批这份脚本：批之前核源没过期、没缺项、给他看的就是现在这份；批准记在 en-script.json，任何一段变了就失效。
 */
import { getContent, type Content } from "../../storage/local-store.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { approveArtifact, checkArtifactApproval, type ApprovalCheck } from "../lineage/artifact-approval.js";
import { staleReason } from "../lineage/lineage.js";
import { readEnScript, SCRIPT_ARTIFACT, scriptHash, scriptProblems, writeEnScript, type EnScript } from "./script.js";
import { writeEnPreview } from "./preview.js";

export interface EnReviewState {
  content: Content;
  script: EnScript;
  evidence: Set<string>;
  problems: string[];
  hash: string;
  approval: ApprovalCheck;
  stale: string | null;
}

export const isEnEdition = (c: Pick<Content, "derivedFrom"> | null | undefined): boolean => c?.derivedFrom?.kind === "en_edition";

/** 能当出处的编号：英文版自己的台账（verify_quote 记的）+ 源视频的台账 */
async function evidenceIds(content: Content, dataDir: string): Promise<Set<string>> {
  const src = content.derivedFrom ? await getContent(content.derivedFrom.contentId, dataDir).catch(missingAsNull) : null;
  return new Set([...(content.evidenceLedger?.entries ?? []), ...(src?.evidenceLedger?.entries ?? [])].map((e) => e.id));
}

export async function enReviewState(contentId: string, dataDir: string, opts: { fresh?: boolean } = {}): Promise<EnReviewState | { code: string; error: string }> {
  const content = await getContent(contentId, dataDir).catch(missingAsNull);
  if (!content) return { code: "not_found", error: `稿件不存在：${contentId}` };
  if (!isEnEdition(content)) return { code: "not_en_edition", error: "这条不是由视频派生的英文版" };
  const script = await readEnScript(contentId, dataDir);
  if (!script) return { code: "no_script", error: "还没有英文脚本：先 op:\"source\" 看成片字幕，再 op:\"set_script\"" };
  const evidence = await evidenceIds(content, dataDir);
  const hash = scriptHash(script);
  const stale = await staleReason(content, dataDir, opts);
  const drift = script.sourceCutHash !== content.derivedFrom!.sourceCutHash ? ["脚本是按另一版成片写的：按当前成片重写"] : [];
  const problems = [...(stale ? [stale] : []), ...drift, ...scriptProblems(script, evidence)];
  return { content, script, evidence, problems, hash, approval: checkArtifactApproval(script.approval, hash), stale };
}

export function enApprovalText(s: Pick<EnReviewState, "script" | "approval">): string {
  if (s.approval.ok) return `已批准（${s.script.approval!.approvedAt}）`;
  return s.script.approval ? `批准已失效：${s.approval.reason}` : "还没批";
}

export function renderEnReviewPage(s: EnReviewState, dataDir: string): Promise<string> {
  return writeEnPreview({ contentId: s.content.id, title: s.content.title, script: s.script, problems: s.problems, approval: enApprovalText(s), evidence: s.evidence }, dataDir);
}

export function enBriefLines(s: EnReviewState, page: string): string[] {
  return [
    `英文版中英对照审阅页（逐段中文原句 / 英文 / 时间预算 / 换掉的例子）：${page}`,
    s.problems.length ? `还不能批：\n${s.problems.map((p, i) => `  ${i + 1}) ${p}`).join("\n")}` : "都齐了：他说「没问题」就可以批，批的是这一整份脚本（每段的中英文、换例、关键词）。",
    `批准状态：${enApprovalText(s)}`,
  ];
}

export type GateResult = { ok: true; hash: string } | { ok: false; code: string; error: string };

/** expected = 给创始人看的那份脚本的指纹（认稿那件的 detail.package_hash） */
export async function enScriptApproveGate(contentId: string, dataDir: string, expected: string | undefined): Promise<GateResult> {
  const s = await enReviewState(contentId, dataDir, { fresh: true });
  if ("error" in s) return { ok: false, code: s.code, error: s.error };
  if (!expected || expected !== s.hash) return { ok: false, code: "stale", error: "英文脚本在给你看之后变了：重新看一眼对照页再批" };
  if (s.stale) return { ok: false, code: "derived_stale", error: `这条英文版过期了，不能批：${s.stale}` };
  if (s.problems.length) return { ok: false, code: "script_not_ready", error: `英文脚本还不能批：\n${s.problems.map((p, i) => `${i + 1}) ${p}`).join("\n")}` };
  return { ok: true, hash: s.hash };
}

export async function recordEnScriptApproval(contentId: string, hash: string, dataDir: string): Promise<void> {
  const script = await readEnScript(contentId, dataDir);
  if (!script) throw new Error("英文脚本不见了：批准没记上");
  await writeEnScript(contentId, { ...script, approval: approveArtifact(SCRIPT_ARTIFACT, hash) }, dataDir);
}
