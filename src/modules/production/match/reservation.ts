/**
 * pending_match 是对该 sha 的预留（1b §3-7，§14-3）：所有收 A-roll 的入口（record、候选确认、卡片挂载，
 * 1b 段 B 的收件箱自动挪与改挂）在同一把文件归属锁里查「各轮 accepted 归属 + 当前 pending 预留」。
 */
import { getContent } from "../../../storage/local-store.js";
import { readProductionDoc } from "../../../storage/production-store.js";
import type { Fact } from "../../../storage/production-types.js";
import { shaIndex } from "../sha-index.js";

export interface PendingHolder { content_id: string; title: string; fact: Fact }

/** 别条稿本轮正在核对这份原片 → 那条稿；已删 / 已归档的稿不算预留 */
export async function pendingElsewhere(dataDir: string, sha: string, contentId: string): Promise<PendingHolder | null> {
  for (const e of (await shaIndex(dataDir)).entries[sha] ?? []) {
    if (e.content_id === contentId || e.kind !== "aroll" || e.state !== "pending_match") continue;
    const doc = await readProductionDoc(e.content_id, dataDir).catch(() => null);
    const fact = doc?.facts.find((f) => f.id === e.fact_id && f.round === doc.round && f.state === "pending_match");
    if (!fact) continue;
    const c = await getContent(e.content_id, dataDir);
    if (!c || c.deletedAt || c.status === "archived") continue;
    return { content_id: c.id, title: c.title, fact };
  }
  return null;
}

export const pendingElsewhereText = (title: string) => `正在核对这段原片是不是《${title}》的原片`;
