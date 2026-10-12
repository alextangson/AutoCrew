/**
 * 一条视频的各平台标签（spec 2026-10-12 B）：服务端 targets.ts 的对应件，纯函数。
 * 状态是服务端推导出来的（回执槽），界面不按原始 status 猜；每个按平台的动作都带平台和轮次。
 */
import { platformLabel } from "../lib";

export type TargetState = "未发" | "已定时" | "审核中" | "已公开" | "应已公开" | "被驳回" | "待核" | "读不到";
export type TargetAction = "prepare_publish" | "i_published" | "resubmit" | "confirm_receipt" | "correct_publish";
export interface PublishTarget { platform: string; state: TargetState; reason?: string; url?: string; slot_id?: string; fact_id?: string; actions: TargetAction[] }

export type ChipTone = "done" | "wait" | "todo" | "bad" | "unknown";
const TONE: Record<TargetState, ChipTone> = { 已公开: "done", 应已公开: "wait", 已定时: "wait", 审核中: "wait", 未发: "todo", 被驳回: "bad", 待核: "unknown", 读不到: "unknown" };
export const chipTone = (s: TargetState): ChipTone => TONE[s];

/** 一个标签上的字：「抖音 · 已公开」；被驳回带原因 */
export function chipText(t: PublishTarget): string {
  return `${platformLabel(t.platform)} · ${t.state}${t.state === "被驳回" && t.reason ? `：${t.reason}` : ""}`;
}

/** 卡上要不要显示平台标签：有计划 / 回执，或者已经到待发布以后；写稿中只有一个「未发」是噪音 */
export function showChips(targets: PublishTarget[] | undefined, column: string | null | undefined): boolean {
  if (!targets?.length) return false;
  return column === "待发布" || column === "已发布" || targets.length > 1 || targets.some((t) => t.state !== "未发");
}

export const ACTION_LABEL: Record<TargetAction, string> = {
  prepare_publish: "准备发布", i_published: "标已发", resubmit: "重新提交", confirm_receipt: "确认发了", correct_publish: "纠正：没发",
};

/** 按平台动作 → 现有命令（/api/board/decision 的 action + 参数）；准备发布 / 重新提交走发布对话，不是决定 */
export function targetDecision(t: PublishTarget, a: TargetAction, round: number): { action: string; params: Record<string, unknown> } | null {
  const base = { platform: t.platform, round };
  if (a === "i_published") return { action: "i_published", params: base };
  if (a === "confirm_receipt") return t.fact_id ? { action: "confirm_receipt", params: { ...base, fact_id: t.fact_id } } : null;
  if (a === "correct_publish") return { action: "correct_publish", params: { ...base, ...(t.slot_id ? { target_id: t.slot_id } : {}) } };
  return null;
}

/** 写给发布对话的一句话：哪条稿、哪个平台（四平台共用一条 content_id，不新建稿） */
export function publishAsk(contentId: string, title: string, t: PublishTarget, a: TargetAction): string {
  const verb = a === "resubmit" ? `重新提交到${platformLabel(t.platform)}（上次被驳回${t.reason ? `：${t.reason}` : ""}）` : `发到${platformLabel(t.platform)}`;
  return `把《${title}》${verb}。content_id=${contentId}，platform=${t.platform}；同一条视频四个平台共用这条稿，不要新建稿件。`;
}

/** 同一选题的其它卡（边界 4：视频一张、公众号一张，卡上标「同主题」互相跳） */
export function sameTopicCards<T extends { id: string; topicId: string | null; platform: string | null }>(items: T[], item: T): T[] {
  if (!item.topicId) return [];
  return items.filter((x) => x.id !== item.id && x.topicId === item.topicId);
}
