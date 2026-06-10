/**
 * Outcome Store — append-only JSONL journal（PRD v3 §5 持久化约束：追加式、幂等、可冷启动重放）。
 *
 * 文件：<dataDir>/outcomes.jsonl，一行一条 PerformanceOutcome。
 * 幂等：同 outcomeKey 后写覆盖先写（读取时 latest-wins），journal 本身永不改写。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { validateOutcome, outcomeKey, normalizeTitle, type PerformanceOutcome } from "./outcome-schema.js";
import { listContents, type Content } from "../../storage/local-store.js";

const OUTCOMES_FILE = "outcomes.jsonl";

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

function outcomesPath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), OUTCOMES_FILE);
}

async function readJournal(dataDir?: string): Promise<PerformanceOutcome[]> {
  let raw: string;
  try {
    raw = await fs.readFile(outcomesPath(dataDir), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const outcomes: PerformanceOutcome[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      outcomes.push(JSON.parse(line) as PerformanceOutcome);
    } catch {
      // 跳过损坏行：单行损坏不应清空整个读视图
    }
  }
  return outcomes;
}

/** latest-wins：同幂等键只保留 journal 中最后一条 */
export async function listOutcomes(dataDir?: string): Promise<PerformanceOutcome[]> {
  const journal = await readJournal(dataDir);
  const byKey = new Map<string, PerformanceOutcome>();
  for (const o of journal) {
    byKey.set(outcomeKey(o), o);
  }
  return Array.from(byKey.values());
}

export async function getOutcomesForContent(
  contentId: string,
  dataDir?: string,
): Promise<PerformanceOutcome[]> {
  return (await listOutcomes(dataDir)).filter((o) => o.contentId === contentId);
}

export interface RecordResult {
  ok: boolean;
  outcome?: PerformanceOutcome;
  replaced: boolean;
  error?: string;
}

export async function recordOutcome(
  input: Omit<PerformanceOutcome, "recordedAt" | "needsReview" | "reviewReasons">,
  dataDir?: string,
): Promise<RecordResult> {
  const validation = validateOutcome(input);
  if (!validation.ok) {
    return { ok: false, replaced: false, error: validation.reasons.join("；") };
  }

  const existing = await listOutcomes(dataDir);
  const key = outcomeKey(input);
  const replaced = existing.some((o) => outcomeKey(o) === key);

  // 暴涨检测：同平台已有 ≥5 条数据时，views > 20 × 中位数 → needsReview
  const reviewReasons = [...validation.reasons];
  let needsReview = validation.needsReview;
  const peers = existing
    .filter((o) => o.platform === input.platform)
    .flatMap((o) => (typeof o.metrics.views === "number" ? [o.metrics.views] : []))
    .sort((a, b) => a - b);
  if (peers.length >= 5 && typeof input.metrics.views === "number") {
    const median = peers[Math.floor(peers.length / 2)];
    if (median > 0 && input.metrics.views > median * 20) {
      needsReview = true;
      reviewReasons.push(`播放量 ${input.metrics.views} 超过平台中位数 ${median} 的 20 倍，确认非读错字段`);
    }
  }

  const outcome: PerformanceOutcome = {
    ...input,
    recordedAt: new Date().toISOString(),
    needsReview,
    reviewReasons,
  };

  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(outcomesPath(dataDir), JSON.stringify(outcome) + "\n", "utf-8");
  return { ok: true, outcome, replaced };
}

/** bigram Dice 系数，0-1 */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      set.set(bg, (set.get(bg) || 0) + 1);
    }
    return set;
  };
  const aB = bigrams(a);
  const bB = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of aB) {
    overlap += Math.min(count, bB.get(bg) || 0);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

const FUZZY_THRESHOLD = 0.6;
const STRICT_THRESHOLD = 0.8;
const TIME_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * draft↔outcome 双因子匹配（PRD §6 verify）：
 * 归一化标题精确命中 → 直接匹配；
 * 模糊命中（dice ≥ 0.6）→ 需发布时间窗 ±48h 佐证；双方任一缺发布时间则要求 dice ≥ 0.8。
 */
export async function matchDraft(
  platform: string,
  platformTitle: string,
  publishedAt: string | null,
  dataDir?: string,
): Promise<Content | null> {
  const contents = await listContents(dataDir);
  const candidates = contents.filter(
    (c) => c.status === "published" && c.platform === platform,
  );
  const target = normalizeTitle(platformTitle);

  let best: { content: Content; score: number } | null = null;
  for (const c of candidates) {
    const score = diceSimilarity(normalizeTitle(c.title), target);
    if (score === 1) return c;
    if (!best || score > best.score) best = { content: c, score };
  }
  if (!best || best.score < FUZZY_THRESHOLD) return null;

  const draftTime = best.content.publishedAt ? Date.parse(best.content.publishedAt) : null;
  const itemTime = publishedAt ? Date.parse(publishedAt) : null;
  if (draftTime !== null && itemTime !== null) {
    return Math.abs(draftTime - itemTime) <= TIME_WINDOW_MS ? best.content : null;
  }
  return best.score >= STRICT_THRESHOLD ? best.content : null;
}
