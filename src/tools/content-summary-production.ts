/**
 * `content summary` 的制作段字段（1b §8，§14-16/17）：制作段稿件，以及已有制作事实或 pending 的写稿段稿件。
 *
 * - `aroll[]`：本轮原片事实（fact_id、state、round、绝对路径、候选 / 作废原因）——agent 轮询 pending_match 就看这里取新路径。
 * - `changes[]`：时间线按 seq 升序分页。`since_seq` 之后（不传给最近 10 条）；放不下就截尾，
 *   `next_since_seq` 只推进到最后实际返回的那条，`has_more=true`，绝不因截断跳过事件。
 * - 总长 ≤ 1.5 KB：先截 changes（翻页），再截候选依据，最后截原片原因。
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
 * 本轮原片：pending 的、本页 changes 提到的一律给（刚落定的新路径靠它取，Codex 审 segA P2）；
 * 其余只顺带给最近 `extra` 条，预算紧时先缩它。放不下的靠翻页（changes 截尾 → has_more）。
 */
function arollView(doc: ProductionDoc, root: string, reasonMax: number, referenced: ReadonlySet<string>, extra: number) {
  const round = doc.facts.filter((f) => f.round === doc.round && f.kind === "aroll");
  const must = new Set(round.filter((f) => f.state === "pending_match" || referenced.has(f.id)).map((f) => f.id));
  for (const f of round.filter((x) => !must.has(x.id)).slice(-extra)) must.add(f.id);
  return round.filter((f) => must.has(f.id)).map((f) => ({
    fact_id: f.id, state: f.state, round: f.round,
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

export async function productionPart(c: Content, exp: Explanation, dataDir: string, sinceSeq: number | undefined): Promise<ProductionPart | null> {
  const doc = await readProductionDoc(c.id, dataDir).catch(() => null);
  if (!doc || (exp.phase !== "production" && !hasProductionTrace(doc))) return null;
  const all = await readTimeline(c.id, dataDir, sinceSeq ?? 0).catch(() => [] as TimelineEvent[]);
  const window = (sinceSeq === undefined ? all.slice(-RECENT) : all).map(changeOf);
  let shown = window.length;
  const candidates = candidatesView(doc, exp);
  let evidenceMax = 60;
  let reasonMax = 60;
  let extra = 5;
  const fields: Record<string, unknown> = {};
  const render = () => {
    const changes = window.slice(0, shown);
    const last = changes.at(-1)?.seq;
    Object.assign(fields, {
      missing: exp.missing, badges: exp.badges,
      candidates: candidates.map((x) => ({ ...x, evidence: clip(x.evidence, evidenceMax) })),
      pending: doc.facts.filter((f) => f.round === doc.round && f.state === "pending_match").map((f) => ({ fact_id: f.id, started_at: f.match_started_at ?? f.at })),
      aroll: arollView(doc, contentRoot(c.id, dataDir), reasonMax, new Set(changes.flatMap((x) => (x.fact_id ? [x.fact_id] : []))), extra),
      changes, latest_seq: doc.seq, next_since_seq: last ?? sinceSeq ?? doc.seq,
      has_more: shown < window.length || (sinceSeq !== undefined && all.length > window.length),
    });
  };
  render();
  // 至少留一条变化：一条都不给会让翻页原地打转
  const shrink = () => {
    if (extra > 0) { extra = 0; render(); return true; }
    if (shown > 1) { shown -= 1; render(); return true; }
    if (evidenceMax > 0) { evidenceMax = evidenceMax > 20 ? 20 : 0; render(); return true; }
    // 最后手段：原片的候选 / 作废原因也截短（路径与状态留着，agent 要靠它们）
    if (reasonMax > 20) { reasonMax = 20; render(); return true; }
    return false;
  };
  return { fields, shrink };
}
