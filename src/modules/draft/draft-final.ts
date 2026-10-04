/**
 * prepare_final 的定稿清单（会审 #1/#3/#5）：agent 交「事实句 → 证据编号」映射，这里按交接出处门的口径
 * （factualSentences：真实数字句 + 明确归因句）逐句对，数字再用 number-gate 对所引证据核值与单位。
 * 对不上的标「未核验」列给创始人；清单绑定当时的稿件指纹，正文一改就要重新 prepare_final。
 * 每一项的编号 = 字段 + 位置 + 上下文哈希，同一版重复提交得到同样的编号。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { contentFile, isMissing } from "../../storage/content-project.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import type { LedgerEntry } from "../research/evidence-ledger.js";
import { verifyNumbers } from "../writing/number-gate.js";
import { factualSentences } from "../video/handoff/factual-sentences.js";

export const FINAL_FILE = "draft-final.json";

export interface MappingInput { text: string; evidence_ids: string[] }

export interface ChecklistItem {
  id: string;
  status: "sourced" | "unsourced";
  start: number;
  end: number;
  text: string;
  evidence_ids: string[];
  /** 所引证据里找不到同值同单位的数字 */
  numbers_unsourced: string[];
  /** 模糊量词等 number-gate 判为要人看的数字（不拦，只列） */
  needs_human: string[];
  reason?: string;
}

export interface FinalChecklist {
  draft_hash: string;
  prepared_at: string;
  items: ChecklistItem[];
  review: Record<string, unknown> | null;
}

interface Span { start: number; end: number; evidence: string[] }

const itemId = (start: number, text: string) => `body:${start}:${createHash("sha256").update(text).digest("hex").slice(0, 10)}`;

/** 映射是模型交的：逐条在正文里定位、证据编号要在台账里；有错就整批退回让 agent 改 */
export function locateMapping(body: string, mapping: MappingInput[], entries: readonly LedgerEntry[]): { spans: Span[]; errors: string[] } {
  const known = new Set(entries.map((e) => e.id));
  const spans: Span[] = [];
  const errors: string[] = [];
  for (const [i, m] of mapping.entries()) {
    const text = String(m.text ?? "").trim();
    const at = text ? body.indexOf(text) : -1;
    if (at < 0) { errors.push(`第 ${i + 1} 条映射的句子在正文里找不到：「${text.slice(0, 30)}」`); continue; }
    const unknown = m.evidence_ids.filter((id) => !known.has(id));
    if (unknown.length) { errors.push(`第 ${i + 1} 条映射引用了台账里没有的证据：${unknown.join("、")}`); continue; }
    spans.push({ start: at, end: at + text.length, evidence: m.evidence_ids });
  }
  return { spans, errors };
}

function judge(text: string, evidence: string[], entries: readonly LedgerEntry[]): Pick<ChecklistItem, "status" | "numbers_unsourced" | "needs_human" | "reason"> {
  const cited = entries.filter((e) => evidence.includes(e.id));
  const verdict = verifyNumbers({ title: "", hook: "", body: text, cta: "" }, cited);
  const numbersUnsourced = verdict.unverified.map((m) => m.raw.trim());
  const needsHuman = verdict.needsHuman.map((m) => m.raw.trim());
  if (!evidence.length) return { status: "unsourced", numbers_unsourced: numbersUnsourced, needs_human: needsHuman, reason: "没有对上证据" };
  if (numbersUnsourced.length) return { status: "unsourced", numbers_unsourced: numbersUnsourced, needs_human: needsHuman, reason: `数字 ${numbersUnsourced.join("、")} 在所引证据里找不到` };
  return { status: "sourced", numbers_unsourced: [], needs_human: needsHuman };
}

const overlaps = (s: { start: number; end: number }, t: { start: number; end: number }) => s.start < t.end && t.start < s.end;

/** 逐句出清单：必须出处的句子全进；agent 额外映射的非事实句（如无数字的转述）也进 */
export function buildChecklist(body: string, spans: Span[], entries: readonly LedgerEntry[]): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const sentences = factualSentences(body);
  for (const s of sentences) {
    const evidence = [...new Set(spans.filter((m) => overlaps(m, s)).flatMap((m) => m.evidence))];
    const text = body.slice(s.start, s.end);
    items.push({ id: itemId(s.start, text), start: s.start, end: s.end, text, evidence_ids: evidence, ...judge(text, evidence, entries) });
  }
  for (const m of spans.filter((m) => !sentences.some((s) => overlaps(m, s)))) {
    const text = body.slice(m.start, m.end);
    items.push({ id: itemId(m.start, text), start: m.start, end: m.end, text, evidence_ids: m.evidence, ...judge(text, m.evidence, entries) });
  }
  return items.sort((a, b) => a.start - b.start);
}

export async function saveChecklist(contentId: string, checklist: FinalChecklist, dataDir?: string): Promise<void> {
  await writeJsonAtomicMkdir(contentFile(contentId, dataDir, FINAL_FILE), checklist);
}

export async function loadChecklist(contentId: string, dataDir?: string): Promise<FinalChecklist | null> {
  try { return JSON.parse(await fs.readFile(contentFile(contentId, dataDir, FINAL_FILE), "utf8")) as FinalChecklist; }
  catch (e) { if (isMissing(e)) return null; throw e; }
}

/** 模型可能把映射数组序列化成字符串（中转端点的老毛病）：能解析就解析，解析不了才报错 */
export function normalizeMapping(raw: unknown): MappingInput[] | string {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return "citations 解析不了：传一个数组，每项 {text, evidence_ids}"; }
  }
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return "citations 必须是数组，每项 {text, evidence_ids}";
  return value.map((m) => {
    const o = (m ?? {}) as Record<string, unknown>;
    let ids = o.evidence_ids;
    if (typeof ids === "string") { try { ids = JSON.parse(ids); } catch { ids = ids ? [ids] : []; } }
    return { text: String(o.text ?? ""), evidence_ids: Array.isArray(ids) ? ids.map(String) : [] };
  });
}
