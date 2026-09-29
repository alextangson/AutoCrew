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
export function receiptIdentity(r: Pick<Fact, "platform" | "url" | "item_id" | "evidence" | "at">): string {
  return `${r.platform ?? "?"}|${r.item_id ?? r.url ?? `${r.evidence ?? ""}@${r.at ?? ""}`}`;
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
        evidence: "AutoCrew 发布器的发布记录", ...(p.url ? { url: p.url } : {}), ...(p.postId ? { item_id: p.postId } : {}),
        ...(p.reason ? { reason: p.reason } : {}), ...(p.time ? { at: p.time } : {}),
      });
    }
  }
  for (const b of await bindingsForContent(content.id, dataDir).catch(() => [])) {
    const [platform, ...rest] = b.key.split(":");
    out.push({ platform, item_id: rest.join(":"), pub_state: "public", verified: true, source: "reconcile", evidence: "数据回流抓到了这条作品", at: b.boundAt });
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

/**
 * 把回执并进 doc（就地改）：同一作品身份任何一轮记过都不再导入，只更新本轮那条的状态（审核中 → 已公开 / 驳回）；
 * 同平台的待核回执遇到可信回执 → 标已核实。返回改了几处。
 */
export function mergeReceipts(doc: ProductionDoc, inputs: ReceiptInput[]): number {
  let changed = 0;
  for (const r of inputs) {
    const id = receiptIdentity({ ...r, at: r.at ?? "" });
    const same = doc.facts.find((f) => f.kind === "publish" && (f.receipt_key ?? receiptIdentity(f)) === id);
    if (same) {
      if (same.round === doc.round && (same.pub_state !== r.pub_state || (r.verified && !same.verified))) {
        Object.assign(same, { pub_state: r.pub_state, verified: same.verified || r.verified, ...(r.reason ? { reason: r.reason } : {}) });
        changed++;
      }
      continue;
    }
    doc.facts.push({ ...receiptFact(doc, r), receipt_key: id });
    changed++;
  }
  for (const p of doc.facts.filter((f) => f.kind === "publish" && f.round === doc.round && !f.verified)) {
    const confirmed = doc.facts.some((f) => f.kind === "publish" && f.round === doc.round && f.verified && f.platform === p.platform
      && (!p.url || !f.url || f.url === p.url) && (!p.item_id || !f.item_id || f.item_id === p.item_id));
    if (confirmed) { p.verified = true; p.evidence = `${p.evidence ?? ""}（已由可信回执核实）`; changed++; }
  }
  return changed;
}
