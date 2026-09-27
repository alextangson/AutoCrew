import fs from "node:fs/promises";
import path from "node:path";
import { contentFile, resolveContentProject, isMissing } from "../../../storage/content-project.js";
import { writeJsonAtomic } from "../../../storage/json-atomic.js";
import { draftHash } from "../../../storage/draft-hash.js";
import type { Content } from "../../../storage/local-store.js";
import type { LedgerSource } from "../../research/evidence-ledger.js";

export interface ProjectDecisions {
  draft_hash: string; title: string; cover_text: string; platform: string; target_seconds: number;
  confirmed_at: string; source: "founder-workbench";
}
export interface Citation {
  start: number; end: number; excerpt: string; evidence_id: string;
  sourceType: LedgerSource; sourceUrl?: string; quote: string; verification: string;
}
export interface CitationCoverage { draft_hash: string; citations: Citation[]; reviewed_by: string; reviewed_at: string }
export async function readProjectJson<T>(id: string, file: string, dataDir: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(contentFile(id, dataDir, file), "utf8")) as T; }
  catch (e) { if (isMissing(e)) return null; throw e; }
}
/** Structural coverage only. Source entailment still requires the writer's review. */
export function validateCoverage(content: Content, coverage: CitationCoverage): string[] {
  const errors: string[] = [];
  if (coverage.draft_hash !== draftHash(content)) return ["出处映射不属于当前定稿"];
  if (!Array.isArray(coverage.citations) || !coverage.reviewed_by || !coverage.reviewed_at) return ["缺少出处映射或写稿侧核查记录"];
  const entries = content.evidenceLedger?.entries ?? [];
  for (const c of coverage.citations) {
    if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end <= c.start ||
        c.end > content.body.length || content.body.slice(c.start, c.end) !== c.excerpt) { errors.push("出处正文定位不匹配"); continue; }
    const evidence = entries.find(e => e.id === c.evidence_id);
    if (!evidence || evidence.source !== c.sourceType || evidence.quote !== c.quote || evidence.sourceUrl !== c.sourceUrl) {
      errors.push(`证据字段不匹配：${c.evidence_id}`); continue;
    }
    if (!c.verification?.trim()) errors.push(`缺少核查结论：${c.evidence_id}`);
    if (c.sourceType === "verified_quote" && (!/^https?:\/\//.test(c.sourceUrl ?? "") || !c.quote.trim())) errors.push(`缺少原文链接/原话：${c.evidence_id}`);
    if (c.sourceType !== "verified_quote" && !evidence.reason && !evidence.claim) errors.push(`个人/用户材料缺少依据：${c.evidence_id}`);
  }
  // Treat an entire factual sentence as the coverage unit, not an isolated digit.
  const factual = /\d|[一二三四五六七八九十百千万亿]+[个次人年月日秒分倍%％]|(?:说|表示|指出|认为|声称|宣布|称[，：:「“])/;
  for (const match of content.body.matchAll(/[^。！？!?\n]+[。！？!?]?/g)) {
    if (!factual.test(match[0])) continue;
    const start = match.index! + (match[0].length - match[0].trimStart().length);
    const end = match.index! + match[0].trimEnd().length;
    if (!coverage.citations.some(c => c.start <= start && c.end >= end)) errors.push(`缺少数字/归因出处定位：${start}–${end}`);
  }
  return errors;
}
export async function saveCoverage(content: Content, coverage: CitationCoverage, dataDir: string): Promise<void> {
  const binding = resolveContentProject(content.id, dataDir);
  const errors = validateCoverage(content, coverage);
  if (errors.length) throw new Error(errors.join("；"));
  await writeJsonAtomic(contentFile(content.id, dataDir, "citations.json"), coverage);
  if (binding) await writeJsonAtomic(path.join(binding.project_root, "01-script/evidence/citations.json"), coverage);
}
export async function handoffEvidence(content: Content, dataDir: string): Promise<{ decisions: ProjectDecisions; coverage: CitationCoverage }> {
  const decisions = await readProjectJson<ProjectDecisions>(content.id, "decisions.json", dataDir);
  if (!decisions || decisions.source !== "founder-workbench" || decisions.draft_hash !== draftHash(content) || !decisions.title?.trim() ||
      !decisions.cover_text?.trim() || decisions.platform !== content.platform || !(decisions.target_seconds > 0) || !decisions.confirmed_at) {
    throw new Error("handoff_decisions_missing: 请在工作台确认当前稿件的标题、封面字、平台与目标时长");
  }
  const coverage = await readProjectJson<CitationCoverage>(content.id, "citations.json", dataDir);
  if (!coverage) throw new Error("handoff_citations_missing: 写稿侧需提交当前定稿的逐句出处映射");
  const errors = validateCoverage(content, coverage);
  if (errors.length) throw new Error(`handoff_citations_invalid: ${errors.join("；")}`);
  return { decisions, coverage };
}
export function renderSources(coverage: CitationCoverage): string {
  return "# 出处清单\n\n结构覆盖已检查；语义支持以写稿侧核查为准。\n\n" + coverage.citations.map(c =>
    `## ${c.start}–${c.end} · ${c.evidence_id}\n\n正文：${c.excerpt}\n\n来源：${c.sourceType}\n\n${c.sourceUrl ?? "无外部原文／未外部核验"}\n\n原话：${c.quote}\n\n核查：${c.verification}\n`).join("\n");
}
