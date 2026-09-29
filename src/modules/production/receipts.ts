/**
 * 发布回执（spec §6）：每条回执是本轮的一条 publish 事实，带平台、账号、作品身份、提交状态、证据来源。
 *
 * 可信来源直接核实：AutoCrew 发布器写的 publish-plan.json、数据回流绑到这条稿的作品；创始人「我发了」是决定（decisions.ts）。
 * 模型说的（record kind=publish、模型调 confirm_published）记「待核」，卡上问创始人「是吗？」，
 * 由数据回流自动核实或创始人一键确认（§13-E）。被驳回 ≠ 已发布。
 * 回执按（平台, 作品身份）跨轮去重：重开文稿后，上一轮的发布记录不会被导进新一轮。
 */
import type { Content } from "../../storage/local-store.js";
import { newId } from "../../storage/production-store.js";
import type { Fact, ProductionDoc, PublicationState } from "../../storage/production-types.js";
import { readPublishRecord, type PlatformPublication } from "../../storage/publish-record.js";
import { bindingsForContent } from "../flywheel/platform-items.js";

export interface ReceiptInput {
  platform: string;
  account?: string;
  url?: string;
  item_id?: string;
  pub_state: PublicationState;
  verified: boolean;
  source: Fact["source"];
  evidence: string;
  reason?: string;
  at?: string;
  by?: Fact["by"];
}

const STATE: Partial<Record<PlatformPublication["state"], PublicationState>> = {
  scheduled: "scheduled", overdue: "overdue", public: "public", reviewing: "reviewing", rejected: "rejected", manual: "public", unknown: "reviewing",
};

/** 作品身份：url / item_id；都没有就用（来源, 平台, 时间） */
export function receiptIdentity(r: Pick<Fact, "platform" | "url" | "item_id" | "at">): string {
  // 没有链接 / 作品 id 时按（平台, 发布时间）认；不拿来源说法当身份——说法改了不该变成另一件作品
  return `${r.platform ?? "?"}|${r.item_id ?? r.url ?? `@${r.at ?? ""}`}`;
}

/** 从发布记录（发布器 + 我发了）与数据回流读出这条稿的可信回执 */
export async function trustedReceipts(content: Content, dataDir: string): Promise<ReceiptInput[]> {
  const out: ReceiptInput[] = [];
  const record = await readPublishRecord(content.id, undefined, dataDir);
  if (record.kind !== "none") {
    for (const p of record.platforms) {
      const state = STATE[p.state];
      // 创始人的「我发了」是 i_published 决定（可被纠正），不再另导一条回执，免得纠正之后还挂着
      if (!state || p.state === "manual" || (!p.submitted && p.state !== "rejected")) continue;
      out.push({
        platform: p.platform, pub_state: state, verified: true, source: "reconcile",
        // 发布计划可能是 agent 手写的，不一定出自 AutoCrew 发布器：照实叫「发布计划里的记录」
        evidence: "发布计划里的记录", ...(p.url ? { url: p.url } : {}), ...(p.postId ? { item_id: p.postId } : {}),
        ...(p.reason ? { reason: p.reason } : {}), ...(p.time ? { at: p.time } : {}),
      });
    }
  }
  for (const b of await bindingsForContent(content.id, dataDir).catch(() => [])) {
    const [platform, ...rest] = b.key.split(":");
    // 只有按作品 id（链接解析）绑上的才算已核实；按标题相似绑上的留给创始人确认（创始人拍板 2026-09-29）
    const byId = b.via === "url";
    out.push({ platform, item_id: rest.join(":"), pub_state: "public", verified: byId, source: "reconcile", evidence: byId ? "数据回流按作品 id 对上了这条" : "数据回流按标题猜是这条，等你确认", at: b.boundAt });
  }
  return out;
}

export function receiptFact(doc: ProductionDoc, r: ReceiptInput): Fact {
  return {
    id: newId("fact"), kind: "publish", round: doc.round, state: "accepted", availability: "present", source: r.source, at: r.at ?? new Date().toISOString(),
    platform: r.platform, pub_state: r.pub_state, verified: r.verified, evidence: r.evidence,
    ...(r.account ? { account: r.account } : {}), ...(r.url ? { url: r.url } : {}), ...(r.item_id ? { item_id: r.item_id } : {}),
    ...(r.reason ? { reason: r.reason } : {}), ...(r.by ? { by: r.by } : {}),
  };
}

/** 同一件作品：同平台，且共同有的作品身份（链接 / 作品 id）明确一致；都没有身份时才退回来源键（Codex 审 seg2 P1） */
export function sameWork(a: Pick<Fact, "platform" | "url" | "item_id" | "receipt_key" | "at">, b: Pick<Fact, "platform" | "url" | "item_id" | "receipt_key" | "at">): boolean {
  if (a.platform !== b.platform) return false;
  if ((a.url && b.url && a.url === b.url) || (a.item_id && b.item_id && a.item_id === b.item_id)) return true;
  if (a.url || a.item_id || b.url || b.item_id) return false;
  return (Boolean(a.receipt_key) && a.receipt_key === b.receipt_key) || (Boolean(a.at) && a.at === b.at);
}

/** 发布时间落在哪一轮：按每次「重开文稿」的时间切（Codex 审 seg2 P2：首次发现 ≠ 本轮发布） */
function roundAt(doc: ProductionDoc, at: string): number {
  const t = Date.parse(at);
  const ended = doc.decisions.filter((d) => d.type === "reopen" && Date.parse(d.at) <= t).length;
  return Math.min(doc.round, 1 + ended);
}

/**
 * 并一条可信回执（Codex 审 seg3 P1：新增与更新两条路径都守轮次）：
 * - 可信回执各是各的事实，永远不并进模型的待核声明（声明由下面按同轮核实）；
 * - 已有同一作品的可信回执：属于历史轮 → 不动；本轮的 → 只更新状态 / 别名，时间不明（round_unsure）的永不自动核实；
 * - 新的：按发布时间归轮；时间不明又不在第一轮 → 记待核并标 round_unsure。
 */
function mergeOne(doc: ProductionDoc, r: ReceiptInput): number {
  const key = receiptIdentity({ ...r, at: r.at ?? "" });
  const probe = { platform: r.platform, url: r.url, item_id: r.item_id, receipt_key: key, at: r.at ?? "" };
  const same = doc.facts.find((f) => f.kind === "publish" && f.source !== "record" && sameWork(f, probe));
  if (same) {
    if (same.round !== doc.round) return 0;
    // 同一件作品补了别名（先有链接后有作品 id）：更新原事实，不新增（Codex 审 seg2 P1）
    const patch: Partial<Fact> = { ...(r.url && !same.url ? { url: r.url } : {}), ...(r.item_id && !same.item_id ? { item_id: r.item_id } : {}) };
    if (same.pub_state !== r.pub_state) patch.pub_state = r.pub_state;
    if (r.verified && !same.verified && !same.round_unsure) patch.verified = true;
    if (r.reason && r.reason !== same.reason) patch.reason = r.reason;
    Object.assign(same, patch);
    return Object.keys(patch).length ? 1 : 0;
  }
  const round = r.at ? roundAt(doc, r.at) : doc.round;
  const unsure = !r.at && doc.round > 1;
  doc.facts.push({ ...receiptFact(doc, { ...r, verified: r.verified && !unsure, ...(unsure ? { evidence: `${r.evidence}（发布时间不明，等你确认是不是这一轮）` } : {}) }),
    round, receipt_key: key, ...(unsure ? { round_unsure: true as const } : {}) });
  return 1;
}

/**
 * 把可信回执并进 doc（就地改），再用它们核实本轮的待核声明：作品身份必须明确一致；
 * 被纠正的可信回执不算；可信回执是驳回 → 声明也同步成驳回（不会因此命中 D1）。返回改了几处。
 */
export function mergeReceipts(doc: ProductionDoc, inputs: ReceiptInput[]): number {
  let changed = inputs.reduce((n, r) => n + mergeOne(doc, r), 0);
  const corrected = new Set(doc.decisions.filter((d) => d.type === "publish_correction").map((d) => d.target_id));
  const trusted = doc.facts.filter((f) => f.kind === "publish" && f.verified && f.source !== "record" && !f.round_unsure && !corrected.has(f.id));
  for (const p of doc.facts.filter((f) => f.kind === "publish" && f.round === doc.round && !f.verified && f.source === "record")) {
    const t = trusted.find((x) => x.round === p.round && sameWork(x, p));
    if (!t) continue;
    Object.assign(p, { verified: true, pub_state: t.pub_state, evidence: `${p.evidence ?? ""}（已由可信回执 ${t.id} 核实）` });
    changed++;
  }
  return changed;
}
