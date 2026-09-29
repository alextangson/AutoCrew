/**
 * 旧入口关闭（spec §8）：**只在本体已启用的资料库**生效——启用前，在途的稿（纠正AI、客户问AI）照旧走交接 / 登记收尾。
 * 启用后，这些入口对按本体走的稿返回指路错误；启用时被排除的稿仍走旧路。
 */
import { isOntologyActive, isOntologyEnabled } from "../../storage/production-store.js";

export const ENTRY_CLOSED =
  "本体已启用，这个入口关了：原片 / 成片 / 字幕 / 封面 / ChatCut 工程一律改用 autocrew_content record 报事实；下一步看 autocrew_content summary 的 next_action。认稿、成片通过、选封面、我发了只归创始人点。";

export interface ClosedResult extends Record<string, unknown> { ok: false; code: "entry_closed"; error: string; next_action: { tool: string; params: Record<string, unknown> } }

export function closedResult(contentId?: string): ClosedResult & Record<string, unknown> {
  return { ok: false, code: "entry_closed", error: ENTRY_CLOSED, next_action: { tool: "autocrew_content", params: { action: "summary", ...(contentId ? { id: contentId } : {}) } } };
}

/** 有 content_id：这条按本体走就关；没有（match 这种按文件找稿的）：库启用了就关 */
export async function oldEntryClosed(dataDir: string, contentId?: string): Promise<boolean> {
  return contentId ? isOntologyActive(dataDir, contentId) : isOntologyEnabled(dataDir);
}
