/**
 * 一条视频的各发布平台（spec 2026-10-12 B / 吸收 4、12、13）：卡上每个平台一个标签 + 这个平台还剩什么动作。
 * 平台 = 发布计划里的平台 ∪ 本轮已有回执的平台（不新增存储）；都没有时取稿件平台。
 * 回执独立显示：计划删掉一个平台，已有回执的平台照样列出。纯函数。
 */
import type { Content } from "../../storage/local-store.js";
import type { PublishRecord, PlatformPublication } from "../../storage/publish-record.js";
import type { ProductionDoc } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { canonPlatform, receiptsOfRound, type Slot } from "./receipts.js";

export type TargetState = "未发" | "已定时" | "审核中" | "已公开" | "应已公开" | "被驳回" | "待核" | "读不到";
/** 按平台的动作：前端每个都带平台 + 轮次调现有命令 */
export type TargetAction = "prepare_publish" | "i_published" | "resubmit" | "confirm_receipt" | "correct_publish";

export interface PublishTarget {
  platform: string;
  state: TargetState;
  reason?: string;
  url?: string;
  /** 纠正的目标槽（本轮）；没有回执 = 无 */
  slot_id?: string;
  /** 待核时要确认的那条观察 */
  fact_id?: string;
  actions: TargetAction[];
}

const SLOT_STATE: Record<Slot["pub_state"], TargetState> = { scheduled: "已定时", reviewing: "审核中", public: "已公开", overdue: "应已公开", rejected: "被驳回" };
const PLAN_STATE: Record<PlatformPublication["state"], TargetState> = {
  scheduled: "已定时", overdue: "应已公开", public: "已公开", reviewing: "审核中", rejected: "被驳回", not_submitted: "未发", manual: "已公开", unknown: "读不到",
};

const ACTIONS: Record<TargetState, TargetAction[]> = {
  未发: ["prepare_publish", "i_published"], 被驳回: ["resubmit", "correct_publish"], 待核: ["confirm_receipt", "correct_publish"],
  已定时: ["correct_publish"], 审核中: ["correct_publish"], 已公开: ["correct_publish"], 应已公开: ["correct_publish"], 读不到: [],
};

function fromSlot(s: Slot): PublishTarget {
  const state: TargetState = s.verified ? SLOT_STATE[s.pub_state] : "待核";
  return { platform: s.platform, state, slot_id: s.id, ...(s.fact_id && !s.verified ? { fact_id: s.fact_id } : {}),
    ...(s.reason ? { reason: s.reason } : {}), ...(s.url ? { url: s.url } : {}), actions: ACTIONS[state] };
}

function planPlatforms(record: PublishRecord | null): PlatformPublication[] {
  return record && record.kind !== "none" ? record.platforms : [];
}

/**
 * 视频稿的平台标签。active = 按本体走：状态只认本轮回执槽（计划只给平台清单与「未发 / 读不到」）；
 * 未启用（影子 / 被排除）按发布计划给状态，动作留空（走旧流转）。
 */
export function publishTargets(content: Pick<Content, "platform">, doc: ProductionDoc | null, record: PublishRecord | null, active: boolean): PublishTarget[] {
  if (!isVideoPlatform(content.platform)) return [];
  const plan = planPlatforms(record);
  const slots = active && doc ? receiptsOfRound(doc) : { live: [], rejected: [], pending: [] };
  const bySlot = new Map([...slots.live, ...slots.rejected, ...slots.pending].map((s) => [s.platform, s]));
  const order = [...new Set([...plan.map((p) => canonPlatform(p.platform)), ...bySlot.keys()])];
  if (!order.length) order.push(canonPlatform(content.platform!));
  return order.map((platform) => {
    const slot = bySlot.get(platform);
    if (slot) return fromSlot(slot);
    const entry = plan.find((p) => canonPlatform(p.platform) === platform);
    // 本体稿：计划里报投出、本轮却没有槽（被纠正过 / 上一轮的）= 这一轮还没发；只有读不懂的照原样
    const state: TargetState = record?.kind === "unreadable" && !entry ? "读不到"
      : !entry ? "未发" : active ? (entry.state === "unknown" ? "读不到" : "未发") : PLAN_STATE[entry.state];
    return { platform, state, ...(entry?.reason ? { reason: entry.reason } : {}), ...(entry?.url ? { url: entry.url } : {}), actions: active ? ACTIONS[state] : [] };
  });
}

/** 已发布的定义（吸收 12）：任一平台已定时 / 审核中 / 已公开 / 应已公开 */
export const LIVE_STATES: ReadonlySet<TargetState> = new Set(["已定时", "审核中", "已公开", "应已公开"]);
