import type { Content } from "./local-store.js";
import { readProductionDocOrEmpty } from "./production-store.js";
import { ontologyApplies } from "../modules/production/publish-gate.js";
import { receiptsOfRound } from "../modules/production/receipts.js";

/**
 * 按本体走的稿：发布时间取本轮发布槽里最早的那个（重开后 publishedAt 还留着上一轮的，不能拿来判本轮到点、也不能定 NAS 月份）。
 * 本轮没有投出的槽 = 没有本轮发布时间。旧稿照用 publishedAt。
 */
export async function withRoundPublishTime(c: Content, data: string): Promise<Content> {
  if (!(await ontologyApplies(c, data))) return c;
  const doc = await readProductionDocOrEmpty(c.id, data);
  const times = receiptsOfRound(doc).live.map((s) => Date.parse(s.at)).filter((t) => !Number.isNaN(t));
  return { ...c, publishedAt: times.length ? new Date(Math.min(...times)).toISOString() : null };
}

