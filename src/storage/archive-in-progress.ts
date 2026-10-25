/**
 * 归档用的「还在做」：源视频的派生稿（公众号长文 / 英文版）还没发完或没被标不出，源视频就留在本机
 * ——英文版要用源成片和无字幕母版，公众号长文要读口播转写。按主题分组（derivedFrom 反向索引）判断，不按标题猜。
 */
import type { BoardItem } from "../desktop/board-data.js";
import type { ThemeCard } from "../modules/theme/group.js";

/** 派生稿做完 = 本条稿的每个去向都已发或被标了不出（至少有一行）；或稿件已发布且要发的去向都已发 */
export function childDone(card: ThemeCard, child: BoardItem): boolean {
  const rows = card.destinations.filter((r) => r.content_id === child.id);
  if (rows.length && rows.every((r) => r.state === "已发" || r.skipped)) return true;
  return child.column === "已发布" && rows.every((r) => !r.required || r.state === "已发");
}

/** 父稿 id → 还没做完的派生稿标题 */
export function unfinishedChildren(themes: ThemeCard[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const card of themes) {
    if (card.kind !== "video") continue;
    const open = card.children.filter((ch) => !childDone(card, ch)).map((ch) => ch.title);
    if (open.length) out.set(card.id, open);
  }
  return out;
}

/** 从资料库现算（只读）：看板 + 主题分组 */
export async function loadUnfinishedChildren(data: string, now: Date): Promise<Map<string, string[]>> {
  const [{ boardData }, { listContents }, { themesOf }] = await Promise.all([
    import("../desktop/board-data.js"), import("./local-store.js"), import("../modules/theme/pipeline-data.js"),
  ]);
  const [board, contents] = await Promise.all([boardData(data), listContents(data)]);
  return unfinishedChildren((await themesOf(board, contents, data, now)).themes);
}
