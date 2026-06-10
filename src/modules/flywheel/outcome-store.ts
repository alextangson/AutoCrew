/**
 * Outcome Store — append-only JSONL journal（PRD v3 §5 持久化约束：追加式、幂等、可冷启动重放）。
 *
 * 文件：<dataDir>/outcomes.jsonl，一行一条 PerformanceOutcome。
 * 幂等：同 outcomeKey 后写覆盖先写（读取时 latest-wins），journal 本身永不改写。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  validateOutcome,
  outcomeKey,
  type PerformanceOutcome,
  type OutcomeMetrics,
  type OutcomeSource,
} from "./outcome-schema.js";

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
  try {
    const raw = await fs.readFile(outcomesPath(dataDir), "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PerformanceOutcome);
  } catch {
    return [];
  }
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
  input: {
    contentId: string | null;
    platform: string;
    platformTitle: string;
    publishedAt: string | null;
    metricDate: string;
    metrics: OutcomeMetrics;
    source: OutcomeSource;
  },
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
    .filter((o) => o.platform === input.platform && typeof o.metrics.views === "number")
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
