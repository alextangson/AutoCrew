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
import { EXEMPT_ROLES, extractNumbers, verifyNumbers, type NumberMention } from "../writing/number-gate.js";
import { factualSentences } from "../video/handoff/factual-sentences.js";
import { maybeJson, UNPARSABLE } from "../publish/review-gate/plan.js";

export const FINAL_FILE = "draft-final.json";

/** claim = 要出处的事实（默认）；example = 类比 / 编的例子；judgment = 我们自己的判断——后两种不列为没出处 */
export type CitationKind = "claim" | "example" | "judgment";
export const CITATION_KINDS: readonly CitationKind[] = ["claim", "example", "judgment"];
export interface MappingInput { text: string; evidence_ids: string[]; kind?: CitationKind }

export interface ChecklistItem {
  id: string;
  /** exempt = agent 标成示意 / 判断，不需要出处 */
  status: "sourced" | "unsourced" | "exempt";
  kind?: Exclude<CitationKind, "claim">;
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

interface Span { start: number; end: number; evidence: string[]; kind: CitationKind }

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
    spans.push({ start: at, end: at + text.length, evidence: m.evidence_ids, kind: m.kind ?? "claim" });
  }
  return { spans, errors };
}

const RELATIVE_BEFORE = /(?:前|这|那|近|过去|最近|头)$/;
const RELATIVE_AFTER = /^(?:前|后|以前|以后|之前|之后|以来|来|里|内)/;
/** 「两三个」「一两句」「三四天」：相邻两个数连说 = 约数 */
const APPROX_PAIR = /^(?:一两|两三|三四|四五|五六|六七|七八|八九)/;

/**
 * 清单口径（验收 10-04）：相对时间（前两天、三年前）和没有具体数值的约数（一半人、十几个、两三个）不算要出处的数字；
 * 17 分、52 人、67%、两小时、三成照算。只管定稿清单，写稿数字门照旧。
 */
export function isVagueOrRelative(m: Pick<NumberMention, "raw" | "role" | "kind" | "needsHuman">, before: string, after: string): boolean {
  if (m.needsHuman) return true;
  if (m.kind !== "chinese") return false;
  const raw = m.raw.trim();
  if (/^(?:一半|半)/.test(raw) || APPROX_PAIR.test(raw)) return true;
  return m.role === "duration" && (RELATIVE_BEFORE.test(before) || RELATIVE_AFTER.test(after));
}

function vagueAt(text: string, m: NumberMention): boolean {
  const raw = m.raw.trim();
  let at = text.indexOf(raw, Math.max(0, m.index - 2));
  if (at < 0) at = text.indexOf(raw);
  if (at < 0) return false;
  return isVagueOrRelative(m, text.slice(Math.max(0, at - 2), at), text.slice(at + raw.length, at + raw.length + 2));
}

function judge(text: string, evidence: string[], entries: readonly LedgerEntry[]): Pick<ChecklistItem, "status" | "numbers_unsourced" | "needs_human" | "reason"> {
  const cited = entries.filter((e) => evidence.includes(e.id));
  const verdict = verifyNumbers({ title: "", hook: "", body: text, cta: "" }, cited);
  const numbersUnsourced = verdict.unverified.filter((m) => !vagueAt(text, m)).map((m) => m.raw.trim());
  const needsHuman = verdict.needsHuman.map((m) => m.raw.trim());
  if (!evidence.length) return { status: "unsourced", numbers_unsourced: numbersUnsourced, needs_human: needsHuman, reason: "没有对上证据" };
  if (numbersUnsourced.length) return { status: "unsourced", numbers_unsourced: numbersUnsourced, needs_human: needsHuman, reason: `数字 ${numbersUnsourced.join("、")} 在所引证据里找不到` };
  return { status: "sourced", numbers_unsourced: [], needs_human: needsHuman };
}

const overlaps = (s: { start: number; end: number }, t: { start: number; end: number }) => s.start < t.end && t.start < s.end;

/** 必须出处的句子：有归因，或至少有一个不是相对时间 / 约数的数字 */
function checklistSentences(body: string) {
  const counted = extractNumbers(body).filter((m) => !EXEMPT_ROLES.has(m.role) && !vagueAt(body, m));
  return factualSentences(body).filter((s) => s.attribution || counted.some((m) => m.index >= s.start && m.index < s.end));
}

/** agent 把这句标成示意 / 判断：不列为没出处，单独一组 */
function exemptKind(spans: Span[], at: { start: number; end: number }): ChecklistItem["kind"] {
  return spans.find((m) => m.kind !== "claim" && overlaps(m, at))?.kind as ChecklistItem["kind"];
}

function itemFor(body: string, at: { start: number; end: number }, evidence: string[], spans: Span[], entries: readonly LedgerEntry[]): ChecklistItem {
  const text = body.slice(at.start, at.end);
  const base = { id: itemId(at.start, text), start: at.start, end: at.end, text, evidence_ids: evidence };
  const kind = exemptKind(spans, at);
  if (kind) return { ...base, status: "exempt", kind, numbers_unsourced: [], needs_human: [] };
  return { ...base, ...judge(text, evidence, entries) };
}

/** 逐句出清单：必须出处的句子全进；agent 额外映射的非事实句（如无数字的转述）也进 */
export function buildChecklist(body: string, spans: Span[], entries: readonly LedgerEntry[]): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const sentences = checklistSentences(body);
  for (const s of sentences) {
    const evidence = [...new Set(spans.filter((m) => overlaps(m, s)).flatMap((m) => m.evidence))];
    items.push(itemFor(body, s, evidence, spans, entries));
  }
  for (const m of spans.filter((m) => !sentences.some((s) => overlaps(m, s)))) items.push(itemFor(body, m, m.evidence, spans, entries));
  return items.sort((a, b) => a.start - b.start);
}

export async function saveChecklist(contentId: string, checklist: FinalChecklist, dataDir?: string): Promise<void> {
  await writeJsonAtomicMkdir(contentFile(contentId, dataDir, FINAL_FILE), checklist);
}

export async function loadChecklist(contentId: string, dataDir?: string): Promise<FinalChecklist | null> {
  try { return JSON.parse(await fs.readFile(contentFile(contentId, dataDir, FINAL_FILE), "utf8")) as FinalChecklist; }
  catch (e) { if (isMissing(e)) return null; throw e; }
}

/** 模型可能把映射数组序列化成字符串、还留着没转义的内部引号（中转端点的老毛病）：原样解析 → 修引号重试 → 都不行才报错 */
/** evidence_ids：数组直接用（元素必须是字符串）；像 JSON 的字符串解析（修引号重试）；普通字符串当一个编号；缺省 = 空；别的类型报错 */
function evidenceIdsOf(raw: unknown): string[] | string {
  if (raw === undefined || raw === null) return [];
  const v = maybeJson(raw);
  if (v === UNPARSABLE) return "evidence_ids 看着是 JSON 但解析不了";
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return "evidence_ids 必须是字符串数组";
  return v as string[];
}

export function normalizeMapping(raw: unknown): MappingInput[] | string {
  const value = maybeJson(raw);
  if (value === UNPARSABLE || typeof value === "string") return "citations 解析不了：传一个数组，每项 {text, evidence_ids, kind?}";
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return "citations 必须是数组，每项 {text, evidence_ids}";
  const out: MappingInput[] = [];
  for (const [i, m] of value.entries()) {
    const o = maybeJson(m);
    if (!o || typeof o !== "object" || Array.isArray(o)) return `citations 第 ${i + 1} 项不是 {text, evidence_ids} 对象`;
    const ids = evidenceIdsOf((o as Record<string, unknown>).evidence_ids);
    if (typeof ids === "string") return `citations 第 ${i + 1} 项的 ${ids}`;
    const kind = (o as Record<string, unknown>).kind ?? "claim";
    if (!CITATION_KINDS.includes(kind as CitationKind)) return `citations 第 ${i + 1} 项的 kind 只能是 claim / example / judgment`;
    out.push({ text: String((o as Record<string, unknown>).text ?? ""), evidence_ids: ids, kind: kind as CitationKind });
  }
  return out;
}
