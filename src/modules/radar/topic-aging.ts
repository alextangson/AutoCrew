/**
 * 选题老化的口径（spec §6 Q5 + §8 #7）：没打星的选题放满 7 天进回收站。
 *
 * - 打了 ≥3 星、从回收站捞回过的，不老化；
 * - 起算点 = max(最近一次动作 renewedAt / 入库 createdAt, 上线日标记)——
 *   上线前就在库里的旧选题统一从上线那天起算 7 天，不因为「早就满 3 天了」一上线就被清；
 * - 上线日标记按工作区落一次（第一次清理时写），之后不再改。
 * 卡上的「N 天后进回收站」和清理用同一个起算点（等选角续期只会更晚，卡上不读简报，宁早报不晚报）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir, type Topic } from "../../storage/local-store.js";

export const TOPIC_TTL_DAYS = 7;
export const TOPIC_TTL_MS = TOPIC_TTL_DAYS * 24 * 3600_000;
const MARKER_FILE = "topic-aging-v7.json";
const DAY_MS = 24 * 3600_000;

/** 读上线日标记；没有 = null（只读路径按「今天刚上线」算） */
export async function readAgingStart(dataDir?: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(getDataDir(dataDir), MARKER_FILE), "utf-8")) as { startedAt?: string };
    const t = new Date(raw.startedAt ?? "").getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** 清理路径：没有标记就写一个（now），返回起算下限 */
export async function ensureAgingStart(dataDir: string | undefined, now: number): Promise<number> {
  const existing = await readAgingStart(dataDir);
  if (existing !== null) return existing;
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, MARKER_FILE), JSON.stringify({ startedAt: new Date(now).toISOString() }, null, 2) + "\n", "utf-8");
  return now;
}

/** 不老化：≥3 星，或捞回过 */
export function agingExempt(t: Pick<Topic, "stars" | "restoredAt">): boolean {
  return (typeof t.stars === "number" && t.stars >= 3) || Boolean(t.restoredAt);
}

/** 老化起算点（毫秒）；坏时间戳 = NaN，调用方按「不到期」处理 */
export function agingAnchor(t: Pick<Topic, "renewedAt" | "createdAt">, agingStart: number): number {
  return Math.max(new Date(t.renewedAt ?? t.createdAt).getTime(), agingStart);
}

/** 卡上的「N 天后进回收站」：不老化 / 坏时间戳 = null；到期了还没清（等下一轮）= 0 */
export function agingDaysLeft(t: Pick<Topic, "renewedAt" | "createdAt" | "stars" | "restoredAt">, agingStart: number, now: number): number | null {
  if (agingExempt(t)) return null;
  const anchor = agingAnchor(t, agingStart);
  if (!Number.isFinite(anchor)) return null;
  return Math.max(0, Math.ceil((anchor + TOPIC_TTL_MS - now) / DAY_MS));
}
