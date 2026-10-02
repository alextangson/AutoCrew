/**
 * `content summary` 的制作段字段（1b §8，§14-16/17）：制作段稿件，以及已有制作事实或 pending 的写稿段稿件。
 *
 * - `aroll[]`：本轮全部原片事实（fact_id、state、round、绝对路径、候选 / 作废原因），按 (at, id) 排、只用 `aroll_offset` 翻页
 *   （`aroll_has_more` / `aroll_next_offset`）——agent 轮询 pending_match 就看这里取新路径。
 * - `changes[]`：时间线按 seq 升序分页。`since_seq` 之后（不传给最近 10 条）；放不下就截尾，
 *   `next_since_seq` 只推进到最后实际返回的那条，`has_more=true`，绝不因截断跳过事件。两个游标互不相干。
 * - 总长 ≤ 1.5 KB：先截 changes，再截候选依据、原片原因，最后给原片行分页。
 */
import path from "node:path";
import type { Content } from "../storage/local-store.js";
import { contentRoot } from "../storage/content-project.js";
import { readProductionDoc, readTimeline } from "../storage/production-store.js";
import { PRODUCTION_KINDS, type ProductionDoc, type TimelineEvent } from "../storage/production-types.js";
import type { Explanation } from "../modules/production/explain.js";

export const SUMMARY_BUDGET = 1536;
const RECENT = 10;
const clip = (s: string, n: number): string => (Array.from(s).length > n ? `${Array.from(s).slice(0, n).join("")}…` : s);

interface Change { seq: number; at: string; type: string; fact_id?: string; state?: string }

function changeOf(e: TimelineEvent): Change {
  const d = e.detail ?? {};
  return { seq: e.seq, at: e.at, type: e.type, ...(typeof d.fact_id === "string" ? { fact_id: d.fact_id } : {}), ...(typeof d.state === "string" ? { state: d.state } : {}) };
}

/**
 * 写稿段稿件也给：本轮有 accepted 制作事实，或有过核对（pending_match 或它的结果，靠 match_job 认）。
 * 核对结束转成候选 / 作废之后也照给，轮询的 agent 才看得到终态和原因、能停下来（Codex 审 segA P2）。
 */
export function hasProductionTrace(doc: ProductionDoc): boolean {
  return doc.facts.some((f) => f.round === doc.round && ((f.state === "accepted" && PRODUCTION_KINDS.has(f.kind)) || f.state === "pending_match" || Boolean(f.match_job)));
}

export interface ProductionPart {
  fields: Record<string, unknown>;
  /** 按预算收缩：先少一条 change，再截候选依据；返回 false = 已经缩不动 */
  shrink: () => boolean;
}

/**
 * 本轮原片（Codex 审 segB8 P2）：固定集合 = 本轮全部原片事实，按 (at, id) 排序，只用 aroll_offset 翻页，
 * 跟 changes 翻到哪一页无关。事实状态在两页之间可以变，但不会从集合里消失，也不会换位置。
 */
function arollFacts(doc: ProductionDoc) {
  return doc.facts.filter((f) => f.round === doc.round && f.kind === "aroll")
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

function arollView(facts: ReturnType<typeof arollFacts>, root: string, reasonMax: number) {
  return facts.map((f) => ({    fact_id: f.id, state: f.state, round: f.round,
    ...(f.path ? { path: path.isAbsolute(f.path) ? f.path : path.join(root, f.path) } : {}),
    ...(f.state === "candidate" || f.state === "rejected" ? { reason: clip(f.evidence ?? "", reasonMax) } : {}),
  }));
}

function candidatesView(doc: ProductionDoc, exp: Explanation) {
  return exp.candidates.filter((c) => c.state === "candidate").slice(0, 3).map((c) => {
    const f = doc.facts.find((x) => x.id === c.fact_id);
    return { fact_id: c.fact_id, kind: c.kind, source: f?.source ?? "record", evidence: clip(c.evidence ?? "", 60) };
  });
}

/**
 * `arollOffset`（Codex 审 segB7 P2）：pending 与必给的原片行也可能放不下——放得下多少给多少，
 * 回 `aroll_next_offset` 让 agent 接着读（带 `aroll_offset` 再调 summary），直到没有这个字段。
 */
export async function productionPart(c: Content, exp: Explanation, dataDir: string, sinceSeq: number | undefined, arollOffset = 0): Promise<ProductionPart | null> {
  const doc = await readProductionDoc(c.id, dataDir).catch(() => null);
  if (!doc || (exp.phase !== "production" && !hasProductionTrace(doc))) return null;
  const all = await readTimeline(c.id, dataDir, sinceSeq ?? 0).catch(() => [] as TimelineEvent[]);
  const window = (sinceSeq === undefined ? all.slice(-RECENT) : all).map(changeOf);
  let shown = window.length;
  const candidates = candidatesView(doc, exp);
  let evidenceMax = 60;
  let reasonMax = 60;
  let rowsMax = Infinity;
  const allRows = arollFacts(doc).slice(arollOffset);
  const fields: Record<string, unknown> = {};
  const render = () => {
    const changes = window.slice(0, shown);
    const last = changes.at(-1)?.seq;
    Object.assign(fields, {
      missing: exp.missing, badges: exp.badges,
      candidates: candidates.map((x) => ({ ...x, evidence: clip(x.evidence, evidenceMax) })),
    });
    const page = allRows.slice(0, rowsMax);
    const arollMore = page.length < allRows.length;
    const changesMore = shown < window.length || (sinceSeq !== undefined && all.length > window.length);
    Object.assign(fields, {
      pending: page.filter((f) => f.state === "pending_match").map((f) => ({ fact_id: f.id, started_at: f.match_started_at ?? f.at })),
      aroll: arollView(page, contentRoot(c.id, dataDir), reasonMax),
      changes, latest_seq: doc.seq, next_since_seq: last ?? sinceSeq ?? doc.seq,
      // 两个游标各管各的：changes 看 since_seq / has_more，原片看 aroll_next_offset / aroll_has_more
      has_more: changesMore, aroll_has_more: arollMore,
    });
    if (arollMore) fields.aroll_next_offset = arollOffset + page.length;
    else delete fields.aroll_next_offset;
  };
  render();
  // 至少留一条变化：一条都不给会让翻页原地打转
  const shrink = () => {
    if (shown > 1) { shown -= 1; render(); return true; }
    if (evidenceMax > 0) { evidenceMax = evidenceMax > 20 ? 20 : 0; render(); return true; }
    // 最后手段：原片的候选 / 作废原因也截短（路径与状态留着，agent 要靠它们）
    if (reasonMax > 20) { reasonMax = 20; render(); return true; }
    // 再放不下就给原片行分页（至少留一行，翻页才有进展）
    const n = (fields.aroll as unknown[]).length;
    if (n > 1) { rowsMax = n - 1; render(); return true; }
    return false;
  };
  return { fields, shrink };
}
