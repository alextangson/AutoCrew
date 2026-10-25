/**
 * 选题星级（管线重规划 spec §3、§8 #7）——创始人给选题打 1–5 星，和雷达的机器分分开。
 *
 * 规则：
 * - 1–2 星：立刻进回收站（可恢复），并成为「同来源少推」的负反馈；
 * - 3 星：不老化（中性，不影响打分）；
 * - 4–5 星：不老化，钉在选题列最上面，并成为「同来源多推」的正反馈；
 * - 清掉 / 改星：反馈随之改变——反馈不落盘，每次入库现算自当前星级，撤销天然成立；
 * - 已经开写（有稿件指向它）的选题不许打 1–2 星：进回收站会让稿件的血缘悬空，
 *   和普通删除同一口径（topic_has_drafts），3–5 星照常记。
 *
 * 反馈怎么喂给打分（只此一处）：按来源（topic.source，如 `radar:HN`）汇总
 * 每条打星选题的 (星 − 3)，乘 STAR_POINT 分，夹在 ±STAR_ADJUST_CAP。入库段用
 * 「机器分 + 来源调整」判过线和排序；落库的 topic.score 仍是机器分。
 * 过期进回收站的不算差评——过期 ≠ 不喜欢，它们没有星，不进汇总。
 */
import { getTopic, listContents, listTopics, listTrash, updateTopic, type Topic } from "../../storage/local-store.js";

/** 一颗星偏离中性 3 星 = 雷达分 ±3 分 */
export const STAR_POINT = 3;
/** 单一来源最多被调 ±15 分：够把 70 线附近的题拉上拉下，拉不动远低于线的题 */
export const STAR_ADJUST_CAP = 15;

export type RateResult =
  | { ok: true; topic: Topic; trashed: boolean; message: string }
  | { ok: false; code: "bad_request" | "not_found" | "in_trash" | "topic_has_drafts"; error: string };

/** stars: 1–5 打星；null / 0 清掉。来自模型的参数不保证类型，字符串数字照收 */
export function parseStars(raw: unknown): number | null | undefined {
  if (raw === null || raw === 0 || raw === "0" || raw === "") return null;
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

export async function rateTopic(
  id: string,
  rawStars: unknown,
  opts: { via: "board" | "mcp"; founderWords?: string },
  dataDir?: string,
): Promise<RateResult> {
  const stars = parseStars(rawStars);
  if (stars === undefined) return { ok: false, code: "bad_request", error: "星级要是 1–5 的整数（0 或 null = 清掉）" };
  const topic = await getTopic(id, dataDir);
  if (!topic) return { ok: false, code: "not_found", error: `选题 ${id} 不存在` };
  // 打星前它刚被老化清理挪进回收站（并发）：照实说，不偷偷捞回来
  if (topic.deletedAt) return { ok: false, code: "in_trash", error: `选题《${topic.title}》已在回收站，先恢复再打星` };
  if (stars !== null && stars <= 2) {
    const drafts = (await listContents(dataDir)).filter((c) => c.topicId === id);
    if (drafts.length > 0) {
      return { ok: false, code: "topic_has_drafts", error: `选题《${topic.title}》已经开写（${drafts.length} 篇稿），打 1–2 星会进回收站，先去稿件那边弃用` };
    }
  }
  const now = new Date().toISOString();
  const words = opts.founderWords?.trim();
  const updates: Partial<Topic> = stars === null
    ? { stars: undefined, starredAt: undefined, starredVia: undefined, starWords: undefined }
    : { stars, starredAt: now, starredVia: opts.via, starWords: words || undefined };
  const trashed = stars !== null && stars <= 2;
  if (trashed) updates.deletedAt = now;
  const next = await updateTopic(id, updates, dataDir);
  if (!next) return { ok: false, code: "not_found", error: `选题 ${id} 不存在` };
  const message = stars === null ? `已清掉《${next.title}》的星级`
    : trashed ? `《${next.title}》打了 ${stars} 星，已移入回收站（可恢复），同来源会少推`
    : stars >= 4 ? `《${next.title}》打了 ${stars} 星，已钉住` : `《${next.title}》打了 ${stars} 星，不会自动进回收站`;
  return { ok: true, topic: next, trashed, message };
}

/** 按来源汇总的星级调整（分）。读全部选题（含回收站：1–2 星的就在那儿） */
export async function loadStarAdjustments(dataDir?: string): Promise<Map<string, number>> {
  const [active, trash] = await Promise.all([listTopics(dataDir), listTrash(dataDir)]);
  return starAdjustments([...active, ...trash.topics]);
}

export function starAdjustments(topics: Array<Pick<Topic, "source" | "stars">>): Map<string, number> {
  const sum = new Map<string, number>();
  for (const t of topics) {
    if (typeof t.stars !== "number" || !t.source) continue;
    sum.set(t.source, (sum.get(t.source) ?? 0) + (t.stars - 3));
  }
  const out = new Map<string, number>();
  for (const [source, s] of sum) {
    const pts = Math.max(-STAR_ADJUST_CAP, Math.min(STAR_ADJUST_CAP, s * STAR_POINT));
    if (pts !== 0) out.set(source, pts);
  }
  return out;
}
