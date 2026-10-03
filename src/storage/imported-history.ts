/**
 * 历史作品记录（回流认领规格 2026-10-03 ④）：资料库改造前发布的作品，只有标题、发布日期和
 * 各平台作品 id 绑定，没有正文。它是数据的锚点，不是稿件——生产、审稿、剪辑、发布一律不受理。
 * 判定与拒绝话术只在这一处，各入口共用。
 */
export const IMPORTED_HISTORY = "imported_history" as const;

export const HISTORY_REFUSAL =
  "这是补录的历史作品记录（imported_history）：只有标题、发布日期和平台作品绑定，没有正文，" +
  "不进写稿、审稿、剪辑、发布任何流程。它只用来挂回流数据；要删请用 autocrew_insights history_delete。";

export function isImportedHistory(c: { source?: string } | null | undefined): boolean {
  return c?.source === IMPORTED_HISTORY;
}

/** 入口守卫：是历史记录就返回拒绝原因，否则 null */
export function historyRefusal(c: { source?: string } | null | undefined): string | null {
  return isImportedHistory(c) ? HISTORY_REFUSAL : null;
}
