/**
 * 推进下拉的默认选中项（纯函数）。
 *
 * 为什么存在：后端 allowed_transitions 按状态图的表序下发，「待审」的第一位恰好是
 * 「修订」——默认值不动就点「推进」，一个叫推进的按钮把稿件往后退了一站
 * （创始人 2026-08-24 真机踩中）。默认必须指向管线的前进方向。
 *
 * 规则：
 * 1. 前进方向里**能走的**那一站优先（多站可走取最远——被阶段门拦掉的站不会留下跳跃）；
 * 2. 前进方向全被阶段门拦着 → 默认停在被拦的前进站上，把原因亮出来（比默认后退强）；
 * 3. 没有前进方向（如归档态）→ 维持表序第一位。
 */
import type { AllowedTransition } from "../lib";

/** 管线秩：数值大 = 更靠近发布。修订与待审同秩——一来一回都是审的一部分,互相不算前进 */
const STAGE_RANK: Record<string, number> = {
  topic_saved: 0,
  drafting: 1,
  // 缺证据与写作中同秩:它是「还没写成」的一种,推进方向仍然是草稿就绪
  needs_evidence: 1,
  draft_ready: 2,
  reviewing: 3,
  revision: 3,
  approved: 4,
  editing: 5,
  cover_pending: 6,
  publish_ready: 7,
  publishing: 8,
  published: 9,
  archived: 10,
};

const rank = (status: string): number => STAGE_RANK[status] ?? -1;

/**
 * 归档是**退场**不是推进（P1 §4.4 起「缺证据」也能直接归档）。它的秩最高，
 * 不排除掉的话「缺证据」稿的推进按钮默认会指向归档——一个叫推进的按钮把稿子扔进回收站。
 * 只剩它可走时仍会经表序第一位回落到它（已发布 → 归档就是这条路）。
 */
const TERMINAL = "archived";

export function defaultAdvanceTarget(currentStatus: string, transitions: AllowedTransition[]): string {
  const cur = rank(currentStatus);
  const forward = transitions.filter((t) => rank(t.status) > cur && t.status !== TERMINAL);
  const farthest = (list: AllowedTransition[]): string =>
    list.reduce((best, t) => (rank(t.status) > rank(best.status) ? t : best)).status;
  const open = forward.filter((t) => !t.blockedReason);
  if (open.length > 0) return farthest(open);
  if (forward.length > 0) return farthest(forward);
  return transitions[0]?.status ?? "";
}
