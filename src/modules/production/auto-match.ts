/**
 * 数据回流按标题猜的回执自动对上（创始人 2026-10-25）。
 *
 * 以前：回流作品只按标题对上一篇稿 → 一条待核回执，等创始人点「对，发了」。
 * 现在：下面几条**全部**成立就由系统替他点——记法和他点的一模一样（publish_confirm 指向那条观察），
 * 只是来源记 auto、带上证据；卡上写「自动对上：<平台> <时间>，不对就纠正」，纠正走原来的「没发」。
 * - 同一平台（槽本身就是按平台的）；
 * - 作品发布时间在发布计划里这个平台定时 / 公开时间的 ±2 小时内；计划里没时间就在稿件记录的发布时间之后 24 小时内；
 * - 标题由现有匹配器对上（标题绑定 = 归一化标题精确命中）；
 * - 够像的候选稿只有这一篇。
 * 任何一条不成立（两篇以上候选、时间窗外、只有标题）照旧留给创始人。
 */
import type { Content } from "../../storage/local-store.js";
import type { AutoMatchEvidence, GateStamp, ProductionDoc } from "../../storage/production-types.js";
import { readPublishRecord } from "../../storage/publish-record.js";
import { bindingsForContent } from "../flywheel/platform-items.js";
import { listLatestOutcomes, titleCandidates } from "../flywheel/outcome-store.js";
import { canonPlatform, receiptsOfRound, slotGate } from "./receipts.js";
import { gateFromPlan } from "./publish-check-link.js";
import { newId } from "../../storage/production-store.js";

const SLOT_WINDOW_MS = 2 * 3600_000;
const AFTER_PUBLISH_MS = 24 * 3600_000;

export interface AutoMatchFacts {
  platform: string;
  item_id: string;
  /** 回流作品的发布时间（没有 = 不认） */
  work_published_at: string | null;
  work_title: string;
  /** 发布计划里这个平台的定时 / 公开时间 */
  plan_at: string | null;
  /** 稿件记录的发布时间 */
  content_published_at: string | null;
  /** 够像的候选稿（id + 标题分） */
  candidates: Array<{ id: string; score: number }>;
  content_id: string;
}

export type AutoMatchVerdict = { ok: true; evidence: AutoMatchEvidence } | { ok: false; reason: string };

const ms = (s: string | null) => (s ? Date.parse(s) : NaN);

/** 纯判定：几条条件全成立才对上 */
export function judgeAutoMatch(f: AutoMatchFacts): AutoMatchVerdict {
  const work = ms(f.work_published_at);
  if (Number.isNaN(work)) return { ok: false, reason: "回流作品没有发布时间" };
  if (f.candidates.length !== 1) return { ok: false, reason: f.candidates.length ? `够像的候选稿有 ${f.candidates.length} 篇` : "标题对不上任何候选稿" };
  const only = f.candidates[0];
  if (only.id !== f.content_id) return { ok: false, reason: `唯一候选是别的稿 ${only.id}` };
  const base = { platform: f.platform, item_id: f.item_id, work_published_at: f.work_published_at!, title_score: Math.round(only.score * 1000) / 1000 };
  const plan = ms(f.plan_at);
  if (!Number.isNaN(plan)) {
    return Math.abs(work - plan) <= SLOT_WINDOW_MS ? { ok: true, evidence: { ...base, expected_at: f.plan_at!, expected_kind: "plan_slot" } }
      : { ok: false, reason: `作品发布时间离计划时间 ${f.plan_at} 超过 2 小时` };
  }
  const pub = ms(f.content_published_at);
  if (Number.isNaN(pub)) return { ok: false, reason: "发布计划没写时间、稿件也没记发布时间（只有标题）" };
  return work >= pub && work - pub <= AFTER_PUBLISH_MS ? { ok: true, evidence: { ...base, expected_at: f.content_published_at!, expected_kind: "content_published" } }
    : { ok: false, reason: `作品发布时间不在稿件发布时间 ${f.content_published_at} 之后 24 小时内` };
}

export interface AutoMatchPlan { fact_id: string; platform: string; verdict: AutoMatchVerdict; gate?: GateStamp }

/** 只读：本轮待核的「数据回流按标题猜」槽逐个判；对上的附带把关结论（和创始人点确认时同一算法） */
export async function planAutoMatches(content: Content, doc: ProductionDoc, dataDir: string): Promise<AutoMatchPlan[]> {
  const pending = receiptsOfRound(doc).pending.filter((s) => s.source === "metrics_title" && s.fact_id && s.item_id);
  if (!pending.length) return [];
  const bindings = await bindingsForContent(content.id, dataDir);
  const outcomes = await listLatestOutcomes(dataDir);
  const record = await readPublishRecord(content.id, content.manualPublications, dataDir);
  const out: AutoMatchPlan[] = [];
  for (const s of pending) {
    // 只认标题绑定（url / manual 本来就是可信观察，不会落到这里）
    if (!bindings.some((b) => b.via === "title" && canonPlatform(b.key.split(":")[0]) === s.platform && b.key.split(":").slice(1).join(":") === s.item_id)) continue;
    const row = outcomes.filter((o) => canonPlatform(o.platform) === s.platform && o.platformItemId === s.item_id).find((o) => o.publishedAt) ?? null;
    const plan = record.kind === "none" ? undefined : record.platforms.find((p) => canonPlatform(p.platform) === s.platform);
    const candidates = row ? (await titleCandidates(row.platform, row.platformTitle, dataDir)).map((c) => ({ id: c.content.id, score: c.score })) : [];
    const verdict = judgeAutoMatch({
      platform: s.platform, item_id: s.item_id!, work_published_at: row?.publishedAt ?? null, work_title: row?.platformTitle ?? "",
      plan_at: plan?.scheduledAt ?? plan?.publishedAt ?? null, content_published_at: content.publishedAt ?? null, candidates, content_id: content.id,
    });
    const gate = verdict.ok ? slotGate(doc, s.round, s.platform) ?? await gateFromPlan(content.id, s.platform, dataDir) : undefined;
    out.push({ fact_id: s.fact_id!, platform: s.platform, verdict, ...(gate ? { gate } : {}) });
  }
  return out;
}

/**
 * 写进事务里的 doc：和 confirmReceipt 记一样的 publish_confirm，来源 auto + 证据。
 * 按（平台, 作品 id）重新认那条待核观察——判定时的 doc 可能是预演副本，刚导入的观察 id 和事务里的不同；
 * 槽已经不是待核（创始人确认过 / 纠正过 / 可信观察顶掉了）就不写。
 */
export function applyAutoMatches(doc: ProductionDoc, plans: AutoMatchPlan[]): Array<{ type: string; detail: Record<string, unknown> }> {
  const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
  for (const p of plans) {
    if (!p.verdict.ok) continue;
    const slot = receiptsOfRound(doc).pending.find((s) => s.source === "metrics_title" && s.platform === p.platform && s.item_id === p.verdict.evidence.item_id && s.fact_id);
    if (!slot) continue;
    const id = newId("dec");
    doc.decisions.push({ id, type: "publish_confirm", round: doc.round, at: new Date().toISOString(), source: "auto", fact_id: slot.fact_id!, platform: slot.platform,
      auto_match: p.verdict.evidence, ...(p.gate ? { gate: p.gate } : {}) });
    events.push({ type: "receipt_auto_confirmed", detail: { decision_id: id, fact_id: slot.fact_id, ...p.verdict.evidence } });
  }
  return events;
}
