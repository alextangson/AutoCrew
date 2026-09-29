/**
 * 发布回执（spec §6、E35）——**不可变观察 + 纯函数求值**。
 *
 * 前三轮评审都栽在「合并可变回执」上（轮次串、声明与可信回执互相改、身份变化）。这一版没有合并、没有就地修改：
 *
 * 1. 每次读到的发布信息都是一条**观察**（publish 事实），按（来源, 平台, 作品身份, 状态, 发布时间, 原因）算
 *    `obs_key`；同键已在就不再写（所以反复对账收敛，不累积）。状态变了（审核中 → 驳回）就是一条新观察。
 *    来源四种：plan（发布计划）、metrics_id（数据回流按作品 id 绑上）= 可信；metrics_title（按标题猜）、claim（模型说）= 待核。
 * 2. 轮次在写入时按证据盖一次：有发布时间 → 按历次「重开文稿」切出所属轮；没有时间且不在第一轮 → round_unsure，
 *    永远不会被自动核实，只能等创始人认。
 * 3. **作品**是纯函数分组：同平台、共有链接或作品 id 的观察是同一件作品（先有链接后有 id，会被同一件作品吸收）；
 *    没有身份的只按自身的观察键成组，绝不按「平台 + 时间」凑在一起。
 * 4. 作品状态按固定优先级求：可信观察（最后一条可信的状态为准；驳回 ≠ 已发布） > 创始人确认 > 待核声明。
 *    纠正是创始人决定、指向某条观察 id；被纠正的作品整件不算。
 * 创始人「我发了」是另一种决定（decisions.ts），不在这里。
 */
import type { Content } from "../../storage/local-store.js";
import { newId } from "../../storage/production-store.js";
import type { Fact, ProductionDoc, PublicationState } from "../../storage/production-types.js";
import { readPublishRecord, type PlatformPublication } from "../../storage/publish-record.js";
import { bindingsForContent } from "../flywheel/platform-items.js";

export type ObsSource = "plan" | "metrics_id" | "metrics_title" | "claim";
const TRUSTED: ReadonlySet<ObsSource> = new Set(["plan", "metrics_id"]);

export interface Observation {
  source: ObsSource;
  platform: string;
  url?: string;
  item_id?: string;
  pub_state: PublicationState;
  /** 平台上的发布时间（证据）；没有 = 不知道 */
  published_at?: string;
  reason?: string;
  account?: string;
  by?: Fact["by"];
  evidence: string;
}

const STATE: Partial<Record<PlatformPublication["state"], PublicationState>> = {
  scheduled: "scheduled", overdue: "overdue", public: "public", reviewing: "reviewing", rejected: "rejected", unknown: "reviewing",
};

export function obsKey(o: Pick<Observation, "source" | "platform" | "url" | "item_id" | "pub_state" | "published_at" | "reason">): string {
  return [o.source, o.platform, o.item_id ?? o.url ?? "-", o.pub_state, o.published_at ?? "-", o.reason ?? ""].join("|");
}

/** 可信来源读出来的观察：发布计划（不含创始人「我发了」）+ 数据回流绑定 */
export async function trustedObservations(content: Content, dataDir: string): Promise<Observation[]> {
  const out: Observation[] = [];
  const record = await readPublishRecord(content.id, undefined, dataDir);
  if (record.kind !== "none") {
    for (const p of record.platforms) {
      const state = STATE[p.state];
      if (!state || (!p.submitted && p.state !== "rejected")) continue;
      out.push({ source: "plan", platform: p.platform, pub_state: state, evidence: "发布计划里的记录",
        ...(p.url ? { url: p.url } : {}), ...(p.postId ? { item_id: p.postId } : {}), ...(p.reason ? { reason: p.reason } : {}), ...(p.time ? { published_at: p.time } : {}) });
    }
  }
  for (const b of await bindingsForContent(content.id, dataDir).catch(() => [])) {
    const [platform, ...rest] = b.key.split(":");
    // 只有按作品 id（链接解析）绑上的才算已核实；按标题相似绑上的留给创始人确认（创始人拍板 2026-09-29）
    const byId = b.via === "url";
    out.push({ source: byId ? "metrics_id" : "metrics_title", platform, item_id: rest.join(":"), pub_state: "public", published_at: b.boundAt,
      evidence: byId ? "数据回流按作品 id 对上了这条" : "数据回流按标题猜是这条" });
  }
  return out;
}

// ---- 旧形状兼容（在 production.json 里已经有的 publish 事实，读成观察；不改盘） ----

/** 旧事实的来源：record = 模型声明；数据回流按标题 / 按 id；其余 = 发布计划 */
function legacySource(f: Fact): ObsSource {
  if (f.obs_source) return f.obs_source;
  if (f.source === "record") return "claim";
  if (f.evidence?.includes("按标题")) return "metrics_title";
  if (f.evidence?.includes("数据回流")) return f.verified ? "metrics_id" : "metrics_title";
  return "plan";
}

/** 旧事实的发布时间：新形状直接有；旧 receipt_key 末尾「@时间」是当时的发布时间（空 = 不知道） */
function legacyPublishedAt(f: Fact): string | undefined {
  if (f.published_at) return f.published_at;
  const m = f.receipt_key ? /@([^|]*)$/.exec(f.receipt_key) : null;
  if (m) return m[1] || undefined;
  return f.receipt_key ? undefined : f.at;
}

export interface ObsFact extends Observation { id: string; round: number; round_unsure: boolean; order: number }

export function observationsOf(doc: ProductionDoc): ObsFact[] {
  return doc.facts.flatMap((f, order) => (f.kind !== "publish" || f.state === "rejected" ? [] : [{
    id: f.id, order, round: f.round, round_unsure: Boolean(f.round_unsure), source: legacySource(f), platform: f.platform ?? "?",
    ...(f.url ? { url: f.url } : {}), ...(f.item_id ? { item_id: f.item_id } : {}), pub_state: f.pub_state ?? "reviewing",
    ...(legacyPublishedAt(f) ? { published_at: legacyPublishedAt(f) } : {}), ...(f.reason ? { reason: f.reason } : {}),
    ...(f.by ? { by: f.by } : {}), evidence: f.evidence ?? "",
  }]));
}

// ---- 写入：只追加，同键不重写 ----

/** 发布时间落在哪一轮：按每次「重开文稿」的时间切 */
function roundAt(doc: ProductionDoc, at: string): number {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return doc.round;
  return Math.min(doc.round, 1 + doc.decisions.filter((d) => d.type === "reopen" && Date.parse(d.at) <= t).length);
}

export function observationFact(doc: ProductionDoc, o: Observation, extra: Partial<Fact> = {}): Fact {
  const unsure = !o.published_at && doc.round > 1;
  return {
    id: newId("fact"), kind: "publish", round: o.published_at ? roundAt(doc, o.published_at) : doc.round, state: "accepted", availability: "present",
    source: o.source === "claim" ? "record" : "reconcile", at: o.published_at ?? new Date().toISOString(), obs_source: o.source,
    receipt_key: obsKey(o), platform: o.platform, pub_state: o.pub_state, verified: TRUSTED.has(o.source), evidence: o.evidence,
    ...(o.published_at ? { published_at: o.published_at } : {}), ...(unsure ? { round_unsure: true as const } : {}),
    ...(o.url ? { url: o.url } : {}), ...(o.item_id ? { item_id: o.item_id } : {}), ...(o.reason ? { reason: o.reason } : {}),
    ...(o.account ? { account: o.account } : {}), ...(o.by ? { by: o.by } : {}), ...extra,
  };
}

/** 把观察追加进 doc；与已有观察（含旧形状）同键的跳过。返回新增条数 */
export function importObservations(doc: ProductionDoc, obs: Observation[]): number {
  const known = new Set(observationsOf(doc).map((o) => obsKey(o)));
  let added = 0;
  for (const o of obs) {
    if (known.has(obsKey(o))) continue;
    doc.facts.push(observationFact(doc, o));
    known.add(obsKey(o));
    added++;
  }
  return added;
}

// ---- 求值：作品分组 + 固定优先级 ----

export interface Work {
  /** 这件作品里最新的一条观察 id：纠正 / 确认都指向它（明确的事实 id） */
  id: string;
  ids: string[];
  platform: string;
  url?: string;
  item_id?: string;
  pub_state: PublicationState;
  /** 所属轮次；null = 分不清（只能等创始人认） */
  round: number | null;
  verified: boolean;
  /** 作品状态由谁定：trusted（可信观察）/ founder（创始人确认）/ pending（待核） */
  by: "trusted" | "founder" | "pending";
  source: ObsSource;
  evidence: string;
  host?: string;
  reason?: string;
  /** 发布时间或观察时间（排序与显示用） */
  at: string;
}

function groups(obs: ObsFact[]): ObsFact[][] {
  const parent = obs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ids = new Map<string, number>();
  obs.forEach((o, i) => {
    const keys = [o.url && `u:${o.platform}:${o.url}`, o.item_id && `i:${o.platform}:${o.item_id}`].filter(Boolean) as string[];
    if (!keys.length) keys.push(`k:${obsKey(o)}`);
    for (const k of keys) {
      const j = ids.get(k);
      if (j === undefined) ids.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const out = new Map<number, ObsFact[]>();
  obs.forEach((o, i) => out.set(find(i), [...(out.get(find(i)) ?? []), o]));
  return [...out.values()].map((g) => g.sort((a, b) => a.order - b.order));
}

function evaluate(doc: ProductionDoc, g: ObsFact[], confirmed: Set<string>): Work {
  const last = g[g.length - 1];
  const trusted = g.filter((o) => TRUSTED.has(o.source));
  const decider = trusted.at(-1);
  const knownRound = [...trusted].reverse().find((o) => !o.round_unsure)?.round ?? null;
  const founderOk = g.some((o) => confirmed.has(o.id));
  const base = { id: last.id, ids: g.map((o) => o.id), platform: last.platform, ...(g.find((o) => o.url)?.url ? { url: g.find((o) => o.url)!.url } : {}),
    ...(g.find((o) => o.item_id)?.item_id ? { item_id: g.find((o) => o.item_id)!.item_id } : {}), host: g.find((o) => o.by?.host)?.by?.host,
    at: (decider ?? last).published_at ?? doc.facts[(decider ?? last).order].at };
  if (decider && knownRound !== null) {
    return { ...base, pub_state: decider.pub_state, round: knownRound, verified: true, by: "trusted", source: decider.source, evidence: decider.evidence, ...(decider.reason ? { reason: decider.reason } : {}) };
  }
  if (founderOk) return { ...base, pub_state: decider?.pub_state ?? "public", round: doc.round, verified: true, by: "founder", source: last.source, evidence: last.evidence };
  const round = g.every((o) => o.round_unsure) ? null : [...g].reverse().find((o) => !o.round_unsure)!.round;
  return { ...base, pub_state: last.pub_state, round, verified: false, by: "pending", source: last.source, evidence: last.evidence };
}

/** 全部作品（纯函数）；被纠正的作品（任一观察被纠正）整件剔除 */
export function worksOf(doc: ProductionDoc): Work[] {
  const corrected = new Set(doc.decisions.filter((d) => d.type === "publish_correction").map((d) => d.target_id));
  const confirmed = new Set(doc.decisions.filter((d) => d.type === "publish_confirm" && d.round === doc.round).map((d) => d.fact_id as string));
  return groups(observationsOf(doc)).filter((g) => !g.some((o) => corrected.has(o.id))).map((g) => evaluate(doc, g, confirmed));
}

/** 本轮：已投出 / 被驳回 / 待你确认（轮次不明的也列进待确认） */
export function receiptsOfRound(doc: ProductionDoc): { live: Work[]; rejected: Work[]; pending: Work[] } {
  const ws = worksOf(doc);
  const now = (w: Work) => w.round === doc.round;
  return {
    live: ws.filter((w) => w.verified && now(w) && w.pub_state !== "rejected"),
    rejected: ws.filter((w) => w.verified && now(w) && w.pub_state === "rejected"),
    pending: ws.filter((w) => !w.verified && (now(w) || w.round === null)),
  };
}
