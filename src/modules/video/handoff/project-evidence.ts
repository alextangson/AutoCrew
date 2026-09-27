import fs from "node:fs/promises";
import path from "node:path";
import { contentFile, resolveContentProject, isMissing } from "../../../storage/content-project.js";
import { writeJsonAtomic } from "../../../storage/json-atomic.js";
import { draftHash } from "../../../storage/draft-hash.js";
import type { Content } from "../../../storage/local-store.js";
import type { LedgerEntry, LedgerSource } from "../../research/evidence-ledger.js";
import { verifyNumbers } from "../../writing/number-gate.js";
import { factualSentences, type FactualSentence } from "./factual-sentences.js";

export interface ProjectDecisions {
  draft_hash: string; title: string; cover_text: string; platform: string; target_seconds: number;
  confirmed_at: string; source: "founder-workbench";
}
/** The creator's own opinion or first-hand experience: no ledger entry, basis written in `verification`, always shown as unverified. */
export const CREATOR_OPINION = "creator_opinion";
export const CREATOR_EVIDENCE_ID = "creator";
export interface Citation {
  start: number; end: number; excerpt: string; evidence_id: string;
  sourceType: LedgerSource | typeof CREATOR_OPINION; sourceUrl?: string; quote: string; verification: string;
}
export interface CitationCoverage { draft_hash: string; citations: Citation[]; reviewed_by: string; reviewed_at: string }
export async function readProjectJson<T>(id: string, file: string, dataDir: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(contentFile(id, dataDir, file), "utf8")) as T; }
  catch (e) { if (isMissing(e)) return null; throw e; }
}
const clip = (text: string, max = 20) => (text.length > max ? `${text.slice(0, max)}…` : text);
const reasonOf = (s: FactualSentence) => [s.numbers.length ? `数字 ${s.numbers.join("、")}` : "", s.attribution ? `归因「${clip(s.attribution)}」` : ""].filter(Boolean).join("，");
/** Structural coverage only. Source entailment still requires the writer's review. */
export function validateCoverage(content: Content, coverage: CitationCoverage): string[] {
  if (coverage.draft_hash !== draftHash(content)) return ["出处映射不属于当前定稿"];
  if (!Array.isArray(coverage.citations) || !coverage.reviewed_by || !coverage.reviewed_at) return ["缺少出处映射或写稿侧核查记录"];
  const entries = content.evidenceLedger?.entries ?? [];
  const errors = coverage.citations.flatMap(c => citationErrors(c, content.body, entries));
  // A number the ledger can back must cite the ledger: the creator slot is for claims that have no ledger source.
  const backed = verifyNumbers({ title: "", hook: "", body: content.body, cta: "" }, entries).verified;
  // Treat an entire factual sentence as the coverage unit, not an isolated digit.
  for (const s of factualSentences(content.body)) {
    const covering = coverage.citations.filter(c => c.start <= s.start && c.end >= s.end);
    const at = `${s.start}–${s.end}「${clip(content.body.slice(s.start, s.end))}」`;
    if (!covering.length) { errors.push(`缺少数字/归因出处定位：${at}（${reasonOf(s)}）`); continue; }
    const number = backed.find(v => v.mention.index >= s.start && v.mention.index < s.end);
    if (number && covering.every(c => c.sourceType === CREATOR_OPINION)) {
      errors.push(`数字「${number.mention.raw.trim()}」在台账 ${number.entryId} 有出处，须引用台账条目，不能只记创作者观点：${at}`);
    }
  }
  return errors;
}
function citationErrors(c: Citation, body: string, entries: readonly LedgerEntry[]): string[] {
  if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end <= c.start ||
      c.end > body.length || body.slice(c.start, c.end) !== c.excerpt) return ["出处正文定位不匹配"];
  if (c.sourceType === CREATOR_OPINION) return creatorErrors(c);
  const evidence = entries.find(e => e.id === c.evidence_id);
  if (!evidence || evidence.source !== c.sourceType || evidence.quote !== c.quote || evidence.sourceUrl !== c.sourceUrl) return [`证据字段不匹配：${c.evidence_id}`];
  const errors: string[] = [];
  if (!c.verification?.trim()) errors.push(`缺少核查结论：${c.evidence_id}`);
  if (c.sourceType === "verified_quote" && (!/^https?:\/\//.test(c.sourceUrl ?? "") || !c.quote.trim())) errors.push(`缺少原文链接/原话：${c.evidence_id}`);
  // Seeded material (the topic description `user-topic`, transcripts `om:…`) carries only its own text; that text is the basis.
  if (c.sourceType !== "verified_quote" && !evidence.reason && !evidence.claim && !evidence.quote.trim()) errors.push(`个人/用户材料缺少依据：${c.evidence_id}`);
  return errors;
}
function creatorErrors(c: Citation): string[] {
  const errors: string[] = [];
  if (c.evidence_id !== CREATOR_EVIDENCE_ID) errors.push(`创作者观点的 evidence_id 写 ${CREATOR_EVIDENCE_ID}；台账条目按它自己的来源等级引用：${c.evidence_id}`);
  if (c.sourceUrl) errors.push(`创作者观点不带外部链接；有外部原文请引用台账条目：${c.sourceUrl}`);
  if (!c.verification?.trim()) errors.push("创作者观点缺少核查说明：写明出自哪次反馈或哪段亲历");
  return errors;
}
export async function saveCoverage(content: Content, coverage: CitationCoverage, dataDir: string): Promise<void> {
  const binding = resolveContentProject(content.id, dataDir);
  const errors = validateCoverage(content, coverage);
  if (errors.length) throw new Error(errors.join("；"));
  await writeJsonAtomic(contentFile(content.id, dataDir, "citations.json"), coverage);
  if (binding) await writeJsonAtomic(path.join(binding.project_root, "01-script/evidence/citations.json"), coverage);
}
/**
 * 交接缺料（§13.4-D）：缺决定、缺/错出处映射。带码与缺覆盖的句子，交接在认领写入之前据此拒绝，
 * 回执说清缺什么、谁去补，而不是泛化的「handoff 执行失败」。
 */
export class HandoffEvidenceError extends Error {
  constructor(readonly code: "missing_decisions" | "missing_citations", message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}
/** 当前定稿里没被任何出处覆盖的数字/归因句 */
function uncoveredSentences(content: Content, coverage: CitationCoverage | null): Array<{ start: number; end: number; text: string }> {
  const citations = Array.isArray(coverage?.citations) ? coverage.citations : [];
  return factualSentences(content.body)
    .filter(s => !citations.some(c => c.start <= s.start && c.end >= s.end))
    .map(s => ({ start: s.start, end: s.end, text: content.body.slice(s.start, s.end) }));
}
export async function handoffEvidence(content: Content, dataDir: string): Promise<{ decisions: ProjectDecisions; coverage: CitationCoverage }> {
  const decisions = await readProjectJson<ProjectDecisions>(content.id, "decisions.json", dataDir);
  if (!decisions || decisions.source !== "founder-workbench" || decisions.draft_hash !== draftHash(content) || !decisions.title?.trim() ||
      !decisions.cover_text?.trim() || decisions.platform !== content.platform || !(decisions.target_seconds > 0) || !decisions.confirmed_at) {
    throw new HandoffEvidenceError("missing_decisions", "缺少创作者对当前定稿的交接决定：请在工作台确认标题、封面字、平台与目标时长");
  }
  const coverage = await readProjectJson<CitationCoverage>(content.id, "citations.json", dataDir);
  const problems = coverage ? validateCoverage(content, coverage) : ["还没有提交出处映射"];
  if (problems.length) {
    throw new HandoffEvidenceError("missing_citations", `出处映射缺失或不覆盖当前定稿：${problems.join("；")}`, {
      problems,
      uncovered_sentences: uncoveredSentences(content, coverage?.draft_hash === draftHash(content) ? coverage : null),
    });
  }
  return { decisions, coverage: coverage! };
}
export function renderSources(coverage: CitationCoverage): string {
  return "# 出处清单\n\n结构覆盖已检查；语义支持以写稿侧核查为准。\n\n" + coverage.citations.map(c => c.sourceType === CREATOR_OPINION
    ? `## ${c.start}–${c.end} · ${c.evidence_id}\n\n正文：${c.excerpt}\n\n来源：creator_opinion（创作者本人观点／亲历，不在证据台账）\n\n无外部原文／未外部核验\n\n原话：${String(c.quote ?? "").trim() || "（无，正文即创作者本人表述）"}\n\n核查：${c.verification}\n`
    : `## ${c.start}–${c.end} · ${c.evidence_id}\n\n正文：${c.excerpt}\n\n来源：${c.sourceType}\n\n${c.sourceUrl ?? "无外部原文／未外部核验"}\n\n原话：${c.quote}\n\n核查：${c.verification}\n`).join("\n");
}
