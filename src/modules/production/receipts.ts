/**
 * 发布回执（spec §6、E35）——**每条稿、每一轮、每个平台只有一个发布槽**（创始人 2026-09-29 拍板）。
 *
 * 前四轮评审都栽在「跨来源认同一件作品」（链接 / 作品 id / 时间）上；这一版不再认作品：
 *
 * 1. 观察只追加：每次读到的发布信息是一条 publish 事实（来源、平台、状态、证据时间、原因；链接 / 作品 id 只作显示）。
 *    收敛规则：同一（来源, 平台, 轮次）流里，和**最后一条**完全一样就不写；变了（审核中 → 驳回 → 申诉恢复）就追加。
 * 2. 轮次在写入时盖一次：有发布时间 → 按历次「重开文稿」切；没有时间 → 同平台历史上见过同一链接 / 作品 id 就沿用那一轮
 *    （数据回流晚到的绑定不把旧作品算进新一轮），否则算当前轮；创始人可以「纠正」。
 * 3. 槽的状态：本轮该平台出现过的最可信的一类里，**最后一条**说了算——
 *    可信（发布计划、数据回流按作品 id）> 创始人（「我发了」、确认 AI 的说法）> 待核（AI 说发了、数据回流按标题猜）。
 *    删了重发 → 最新的算，早的留作历史。AI 的说法从不靠身份匹配自动核实：同平台同轮来了可信观察就被顶掉，或创始人确认。
 * 4. 纠正指向槽（`slot:<轮次>:<平台>`）：纠正时刻之前槽里的一切作废，之后新来的照算。
 * 已知代价（创始人认可）：同一轮在同一平台发了两件不同作品，只算最新的那件。
 */
import type { Content } from "../../storage/local-store.js";
import { newId } from "../../storage/production-store.js";
import type { Decision, Fact, GateStamp, ProductionDoc, PublicationState } from "../../storage/production-types.js";
import { gateStamp } from "./publish-check-link.js";
import { entryPayloadHash } from "../publish/review-gate/check.js";
import { readPublishRecord, type PlatformPublication } from "../../storage/publish-record.js";
import { bindingsForContent } from "../flywheel/platform-items.js";
import { normalizePlatform } from "../publish/review-gate/platforms.js";

/** 平台名按发布闸门同一张别名表归一（「视频号」= wechat_video）：认不出的原样 */
export const canonPlatform = (p: string): string => normalizePlatform(p) ?? p;

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
  /** 发布前把关记录（发布审查闸门的 check_id） */
  check_id?: string;
  /** 写入时盖的把关结论（publish-check-link） */
  gate?: GateStamp;
  /** 实际提交时间（只用于把关判定，不参与轮次与收敛） */
  submitted_at?: string;
}

const STATE: Partial<Record<PlatformPublication["state"], PublicationState>> = {
  scheduled: "scheduled", overdue: "overdue", public: "public", reviewing: "reviewing", rejected: "rejected", unknown: "reviewing",
};

/** 可信来源读出来的观察：发布计划（不含创始人「我发了」）+ 数据回流绑定 */
export async function trustedObservations(content: Content, dataDir: string): Promise<Observation[]> {
  const out: Observation[] = [];
  const record = await readPublishRecord(content.id, undefined, dataDir);
  if (record.kind !== "none") {
    for (const p of record.platforms) {
      const state = STATE[p.state];
      if (!state || (!p.submitted && p.state !== "rejected")) continue;
      const checkId = p.checkId ?? undefined;
      out.push({ source: "plan", platform: canonPlatform(p.platform), pub_state: state, evidence: "发布计划里的记录",
        ...(p.url ? { url: p.url } : {}), ...(p.postId ? { item_id: p.postId } : {}), ...(p.reason ? { reason: p.reason } : {}),
        ...(p.time ? { published_at: p.time } : {}), ...(checkId ? { check_id: checkId } : {}), ...(p.submittedAt ? { submitted_at: p.submittedAt } : {}) });
    }
  }
  for (const b of await bindingsForContent(content.id, dataDir).catch(() => [])) {
    const [platform, ...rest] = b.key.split(":");
    // 只有按作品 id（链接解析）绑上的才算可信；按标题相似绑上的留给创始人确认（创始人拍板 2026-09-29）。
    // 绑定时间是发现时间不是发布时间，不当作轮次证据
    const byId = b.via === "url";
    out.push({ source: byId ? "metrics_id" : "metrics_title", platform: canonPlatform(platform), item_id: rest.join(":"), pub_state: "public",
      evidence: byId ? "数据回流按作品 id 对上了这条" : "数据回流按标题猜是这条" });
  }
  // 可信观察盖把关结论：按实际提交时间（没有就按现在 = 观察写入时间），从不按定时公开时间；
  // 同槽已经盖过的首次结论由 importObservations 继承，事后补检翻不了案
  for (const o of out) {
    if (!TRUSTED.has(o.source)) continue;
    const payload = o.source === "plan" ? await entryPayloadHash(content.id, o.platform, dataDir).catch(() => null) : null;
    o.gate = await gateStamp(content.id, o.platform, o.submitted_at, o.check_id, dataDir, o.published_at, payload);
  }
  return out;
}

// ---- 读：把 publish 事实（含旧形状）读成观察 ----

function legacySource(f: Fact): ObsSource {
  if (f.obs_source) return f.obs_source;
  if (f.source === "record") return "claim";
  if (f.evidence?.includes("按标题")) return "metrics_title";
  if (f.evidence?.includes("数据回流")) return f.verified ? "metrics_id" : "metrics_title";
  return "plan";
}

export interface ObsFact extends Observation { id: string; round: number; order: number; seen_at: string }

export function observationsOf(doc: ProductionDoc): ObsFact[] {
  return doc.facts.flatMap((f, order) => (f.kind !== "publish" || f.state === "rejected" ? [] : [{
    // 旧形状没有观察时间（at 可能是定时发布的未来时间）：当作「很早以前」，只按写入顺序排，任何纠正都能盖过它
    id: f.id, order, round: f.round, seen_at: f.seen_at ?? "1970-01-01T00:00:00.000Z", source: legacySource(f), platform: canonPlatform(f.platform ?? "?"),
    ...(f.url ? { url: f.url } : {}), ...(f.item_id ? { item_id: f.item_id } : {}), pub_state: f.pub_state ?? "reviewing",
    ...(f.published_at ? { published_at: f.published_at } : {}), ...(f.reason ? { reason: f.reason } : {}),
    ...(f.by ? { by: f.by } : {}), ...(f.check_id ? { check_id: f.check_id } : {}), ...(f.gate ? { gate: f.gate } : {}), evidence: f.evidence ?? "",
  }]));
}

// ---- 写：只追加，和流里最后一条一样就不写 ----

function roundAt(doc: ProductionDoc, at: string): number {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return doc.round;
  return Math.min(doc.round, 1 + doc.decisions.filter((d) => d.type === "reopen" && Date.parse(d.at) <= t).length);
}

/**
 * 轮次证据（创始人 09-30 定，保守）：
 * - AI 的说法（claim）是本轮刚说的：有发布时间按时间切，否则同作品沿用、再否则本轮。
 * - 其余（发布计划、数据回流）在重开之后：**只有带着晚于最近一次重开的实际提交时间（submitted_at）才进新一轮**；
 *   其他一律留在旧轮——包括旧定时帖到点公开、以及没写 submitted_at 的新作品。
 *   已知代价：新一轮真发了但计划没写 submitted_at，不会自动算已发布，创始人点「我发了」（看得见；改口补丁 02 要求写 submitted_at）。
 */
function stampRound(doc: ProductionDoc, o: Observation, known: ObsFact[]): number {
  const seen = known.find((k) => k.platform === o.platform && ((o.item_id && k.item_id === o.item_id) || (o.url && k.url === o.url)));
  if (o.source === "claim" || doc.round === 1) {
    if (o.published_at) return roundAt(doc, o.published_at);
    return seen ? seen.round : doc.round;
  }
  if (o.submitted_at && !Number.isNaN(Date.parse(o.submitted_at))) return roundAt(doc, o.submitted_at);
  const old = doc.round - 1;
  if (seen) return Math.min(seen.round, old);
  return o.published_at ? Math.min(roundAt(doc, o.published_at), old) : old;
}

const same = (a: Observation, b: Observation) =>
  a.pub_state === b.pub_state && (a.published_at ?? "") === (b.published_at ?? "") && (a.url ?? "") === (b.url ?? "")
  && (a.item_id ?? "") === (b.item_id ?? "") && (a.reason ?? "") === (b.reason ?? "") && (a.check_id ?? "") === (b.check_id ?? "");

export function observationFact(doc: ProductionDoc, o: Observation, round: number): Fact {
  const now = new Date().toISOString();
  return {
    id: newId("fact"), kind: "publish", round, state: "accepted", availability: "present", source: o.source === "claim" ? "record" : "reconcile",
    at: o.published_at ?? now, seen_at: now, obs_source: o.source, platform: o.platform, pub_state: o.pub_state, verified: TRUSTED.has(o.source), evidence: o.evidence,
    ...(o.published_at ? { published_at: o.published_at } : {}), ...(o.url ? { url: o.url } : {}), ...(o.item_id ? { item_id: o.item_id } : {}),
    ...(o.reason ? { reason: o.reason } : {}), ...(o.account ? { account: o.account } : {}), ...(o.by ? { by: o.by } : {}), ...(o.check_id ? { check_id: o.check_id } : {}),
    ...(o.gate ? { gate: o.gate } : {}),
  };
}

/** 同一批里同（来源, 平台, 轮次）只留最后一条：静态快照里的多条历史绑定不能每次对账轮流冒充新事件 */
function collapseBatch(doc: ProductionDoc, obs: Observation[]): Array<{ o: Observation; round: number }> {
  // 同批较早的观察也算身份证据：重开后同时读到旧计划（按时间归上一轮）与它的作品 id 绑定，绑定要跟着归上一轮
  const known: Array<Pick<ObsFact, "source" | "platform" | "item_id" | "url" | "published_at" | "round">> = observationsOf(doc);
  const last = new Map<string, { o: Observation; round: number }>();
  for (const o of obs) {
    const round = stampRound(doc, o, known as ObsFact[]);
    known.push({ source: o.source, platform: o.platform, item_id: o.item_id, url: o.url, published_at: o.published_at, round });
    const key = `${o.source}\u0000${o.platform}\u0000${round}`;
    last.delete(key);
    last.set(key, { o, round });
  }
  return [...last.values()];
}

/** 追加观察；同（来源, 平台, 轮次）流里和最后一条完全一样的跳过。返回新增条数 */
export function importObservations(doc: ProductionDoc, obs: Observation[]): number {
  let added = 0;
  for (const { o: raw, round } of collapseBatch(doc, obs)) {
    const known = observationsOf(doc);
    const lastInStream = known.filter((k) => k.source === raw.source && k.platform === raw.platform && k.round === round).at(-1);
    if (lastInStream && same(lastInStream, raw)) continue;
    // 没有发布时间、又和上一轮流里最后一条一模一样：是重开前那份旧记录被再读到，不算进新一轮
    const lastEarlier = known.filter((k) => k.source === raw.source && k.platform === raw.platform && k.round < round).at(-1);
    if (!raw.published_at && lastEarlier && same(lastEarlier, raw)) continue;
    const inherited = raw.gate ? slotGate(doc, round, raw.platform) : undefined;
    doc.facts.push(observationFact(doc, inherited ? { ...raw, gate: inherited } : raw, round));
    added++;
  }
  return added;
}

// ---- 求值：每个平台一个槽 ----

export type SlotClass = "trusted" | "founder" | "pending";

export interface Slot {
  /** 纠正的目标：`slot:<轮次>:<平台>` */
  id: string;
  round: number;
  platform: string;
  pub_state: PublicationState;
  verified: boolean;
  by: SlotClass;
  /** 决定槽状态的那条观察（待核时是 AI 那条，创始人确认要指向它） */
  fact_id: string | null;
  source: ObsSource | "founder";
  evidence: string;
  host?: string;
  url?: string;
  item_id?: string;
  reason?: string;
  check_id?: string;
  /** 决定槽状态那一条的把关结论；没有（旧数据 / AI 说法）= 没把关 */
  gate?: GateStamp;
  /** 证据时间（排序与显示） */
  at: string;
  /** 被顶掉的早先观察（删了重发、AI 说法被可信观察顶掉…） */
  history: string[];
}

export const slotId = (round: number, platform: string) => `slot:${round}:${canonPlatform(platform)}`;

/** 历史纠正存的槽 id 可能带中文平台名（`slot:1:视频号`）：按同一张别名表归一，旧纠正照样生效 */
export function normSlotId(id: string): string {
  const m = /^slot:(\d+):(.+)$/.exec(id);
  return m ? slotId(Number(m[1]), m[2]) : id;
}

/** 槽被纠正的时刻（最后一次纠正）；之前的观察与决定全部作废 */
function correctedAt(doc: ProductionDoc, id: string): number {
  const ds = doc.decisions.filter((d) => d.type === "publish_correction" && d.target_id && normSlotId(d.target_id) === id);
  return ds.length ? Math.max(...ds.map((d) => Date.parse(d.at))) : -Infinity;
}

type Entry = { cls: SlotClass; at: number; pub_state: PublicationState; fact_id: string | null; source: ObsSource | "founder"; evidence: string; o?: ObsFact; d?: Decision };

function entriesOf(doc: ProductionDoc, round: number, platform: string): Entry[] {
  const obs = observationsOf(doc).filter((o) => o.round === round && o.platform === platform);
  const byId = new Map(obs.map((o) => [o.id, o]));
  const decisions = doc.decisions.filter((d) => d.round === round);
  // 旧版纠正指向具体事实 / 决定 id：那一条作废
  const killed = new Set(doc.decisions.filter((d) => d.type === "publish_correction" && d.target_id && !d.target_id.startsWith("slot:")).map((d) => d.target_id!));
  return [
    ...obs.map((o): Entry => ({ cls: TRUSTED.has(o.source) ? "trusted" : "pending", at: Date.parse(o.seen_at) + o.order / 1e6, pub_state: o.pub_state, fact_id: o.id, source: o.source, evidence: o.evidence, o })),
    ...decisions.filter((d) => d.type === "i_published" && canonPlatform(d.platform ?? "") === platform)
      .map((d): Entry => ({ cls: "founder", at: Date.parse(d.at), pub_state: "public", fact_id: null, source: "founder", evidence: "你标了已发布", d })),
    // 创始人确认 AI 的说法：保留那条说法里的提交状态（确认真实性 ≠ 确认已公开）
    ...decisions.filter((d) => d.type === "publish_confirm" && byId.has(d.fact_id ?? ""))
      .map((d): Entry => { const o = byId.get(d.fact_id!)!; return { cls: "founder", at: Date.parse(d.at), pub_state: o.pub_state, fact_id: o.id, source: "founder", evidence: "你确认过 AI 说的发布", o, d }; }),
  ].filter((e) => !killed.has(e.fact_id ?? "") && !killed.has(e.d?.id ?? ""));
}

/**
 * 这个槽（纠正之后）首次盖的把关结论：可信观察或创始人决定里最早的那一个。后来的观察 / 决定一律继承它——
 * 补填 check_id、换来源都翻不了案；被纠正作废的记录不再提供结论。
 */
export function slotGate(doc: ProductionDoc, round: number, platform: string): GateStamp | undefined {
  const cut = correctedAt(doc, slotId(round, platform));
  const gated = entriesOf(doc, round, platform).filter((e) => e.at > cut && e.cls !== "pending")
    .map((e) => ({ at: e.at, gate: e.d?.gate ?? (e.cls === "trusted" ? e.o?.gate : undefined) })).filter((e) => e.gate).sort((a, b) => a.at - b.at);
  return gated[0]?.gate;
}

export function slotOf(doc: ProductionDoc, round: number, platform: string): Slot | null {
  const cut = correctedAt(doc, slotId(round, platform));
  const entries = entriesOf(doc, round, platform).filter((e) => e.at > cut).sort((a, b) => a.at - b.at);
  if (!entries.length) return null;
  const pick = (["trusted", "founder", "pending"] as const).map((c) => entries.filter((e) => e.cls === c).at(-1)).find(Boolean)!;
  const o = pick.o;
  return {
    id: slotId(round, platform), round, platform, pub_state: pick.pub_state, verified: pick.cls !== "pending", by: pick.cls, fact_id: pick.fact_id,
    source: pick.source, evidence: pick.evidence, ...(o?.by?.host ? { host: o.by.host } : {}),
    // 「我发了」时创始人贴的作品链接存在决定的 note 里
    ...(o?.url ? { url: o.url } : pick.d?.type === "i_published" && pick.d.note ? { url: pick.d.note } : {}),
    ...(o?.item_id ? { item_id: o.item_id } : {}), ...(o?.reason ? { reason: o.reason } : {}), ...(o?.check_id ? { check_id: o.check_id } : {}),
    ...(pick.d?.gate ?? o?.gate ? { gate: pick.d?.gate ?? o!.gate } : {}),
    at: o?.published_at ?? o?.seen_at ?? pick.d?.at ?? new Date(pick.at).toISOString(),
    history: entries.filter((e) => e !== pick && e.fact_id).map((e) => e.fact_id!),
  };
}

/** 本轮每个平台的槽：已投出 / 被驳回 / 待你确认 */
export function receiptsOfRound(doc: ProductionDoc): { live: Slot[]; rejected: Slot[]; pending: Slot[] } {
  const platforms = new Set([
    ...observationsOf(doc).filter((o) => o.round === doc.round).map((o) => o.platform),
    ...doc.decisions.filter((d) => d.round === doc.round && d.type === "i_published" && d.platform).map((d) => canonPlatform(d.platform!)),
  ]);
  const slots = [...platforms].map((p) => slotOf(doc, doc.round, p)).filter((s): s is Slot => Boolean(s));
  return {
    live: slots.filter((s) => s.verified && s.pub_state !== "rejected"),
    rejected: slots.filter((s) => s.verified && s.pub_state === "rejected"),
    pending: slots.filter((s) => !s.verified),
  };
}
