/**
 * 生产 / 审稿 / 剪辑 / 发布工具的入口守卫：目标是补录的历史作品记录（imported_history）就整单不受理。
 * 在各工具入口统一调一次——比散落在每个 action 的取稿点更不容易漏。
 */
import { getContent } from "../storage/local-store.js";
import { historyRefusal } from "../storage/imported-history.js";

export type HistoryRefused = { ok: false; code: "imported_history"; error: string } & Record<string, unknown>;

export async function historyGuard(contentId: unknown, dataDir?: string): Promise<HistoryRefused | null> {
  if (typeof contentId !== "string" || !contentId.trim()) return null;
  // 取稿本身失败（项目归属不符等）不在这里判：交给工具自己的取稿点按它的错误形状如实报
  const content = await getContent(contentId.trim(), dataDir).catch(() => null);
  const error = historyRefusal(content);
  return error ? { ok: false, code: "imported_history", error } : null;
}
