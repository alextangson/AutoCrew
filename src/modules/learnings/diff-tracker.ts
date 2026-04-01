/**
 * Diff Tracker — records before/after diffs when users edit content
 *
 * Stores diffs in ~/.autocrew/learnings/edits/ as JSON files.
 * Each diff captures: contentId, field changed, before/after text, timestamp.
 * These diffs feed into the Rule Distiller for pattern recognition.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface EditDiff {
  id: string;
  contentId: string;
  field: "body" | "title" | "hashtags" | "other";
  before: string;
  after: string;
  /** What specifically changed — short description */
  changeType?: string;
  /** Detected patterns in this edit */
  patterns: string[];
  createdAt: string;
}

export interface DiffAnalysis {
  /** Detected edit patterns */
  patterns: string[];
  /** Short human-readable summary */
  summary: string;
}

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

async function editsDir(dataDir?: string): Promise<string> {
  const dir = path.join(getDataDir(dataDir), "learnings", "edits");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Record a content edit diff.
 */
export async function recordDiff(
  contentId: string,
  field: EditDiff["field"],
  before: string,
  after: string,
  dataDir?: string,
): Promise<EditDiff> {
  const dir = await editsDir(dataDir);
  const id = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const patterns = detectPatterns(before, after);

  const diff: EditDiff = {
    id,
    contentId,
    field,
    before: before.slice(0, 2000),
    after: after.slice(0, 2000),
    patterns,
    createdAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(diff, null, 2), "utf-8");
  return diff;
}

/**
 * List all recorded diffs, optionally filtered by contentId.
 */
export async function listDiffs(
  opts?: { contentId?: string; limit?: number },
  dataDir?: string,
): Promise<EditDiff[]> {
  const dir = await editsDir(dataDir);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const diffs: EditDiff[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf-8");
      const diff: EditDiff = JSON.parse(raw);
      if (opts?.contentId && diff.contentId !== opts.contentId) continue;
      diffs.push(diff);
    } catch {
      /* skip corrupted files */
    }
  }

  diffs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (opts?.limit) return diffs.slice(0, opts.limit);
  return diffs;
}

/**
 * Analyze a before/after pair to detect common edit patterns.
 */
export function detectPatterns(before: string, after: string): string[] {
  const patterns: string[] = [];

  // Pattern: removed progression words (首先/其次/最后)
  const progressionBefore = (before.match(/首先|其次|最后|第一|第二|第三/g) || []).length;
  const progressionAfter = (after.match(/首先|其次|最后|第一|第二|第三/g) || []).length;
  if (progressionBefore > progressionAfter && progressionBefore - progressionAfter >= 2) {
    patterns.push("remove_progression_words");
  }

  // Pattern: shortened paragraphs
  const parasBefore = before.split(/\n{2,}/).filter((p) => p.trim());
  const parasAfter = after.split(/\n{2,}/).filter((p) => p.trim());
  if (parasAfter.length > parasBefore.length && after.length <= before.length) {
    patterns.push("break_long_paragraphs");
  }

  // Pattern: removed AI-style phrases
  const aiPhrases = /值得一提的是|需要注意的是|综上所述|总而言之|总的来说|可以说|毫不夸张地说|赋能|助力|打通|闭环|深度|全方位|多维度/g;
  const aiBefore = (before.match(aiPhrases) || []).length;
  const aiAfter = (after.match(aiPhrases) || []).length;
  if (aiBefore > aiAfter && aiBefore - aiAfter >= 2) {
    patterns.push("remove_ai_phrases");
  }

  // Pattern: added colloquial expressions
  const colloquial = /说白了|你想啊|问题来了|讲真|说实话|老实说|不瞒你说|坦白讲/g;
  const collBefore = (before.match(colloquial) || []).length;
  const collAfter = (after.match(colloquial) || []).length;
  if (collAfter > collBefore) {
    patterns.push("add_colloquial_tone");
  }

  // Pattern: reduced "我们" usage
  const weBefore = (before.match(/我们/g) || []).length;
  const weAfter = (after.match(/我们/g) || []).length;
  if (weBefore > weAfter && weBefore - weAfter >= 2) {
    patterns.push("reduce_we_pronoun");
  }

  // Pattern: shortened overall length
  if (after.length < before.length * 0.8) {
    patterns.push("shorten_content");
  }

  // Pattern: added emoji
  const emojiBefore = (before.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  const emojiAfter = (after.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiAfter > emojiBefore + 2) {
    patterns.push("add_emoji");
  }

  // Pattern: replaced formal words with casual
  const formalWords = /因此|然而|此外|尽管|虽然|但是|不过/g;
  const formalBefore = (before.match(formalWords) || []).length;
  const formalAfter = (after.match(formalWords) || []).length;
  if (formalBefore > formalAfter && formalBefore - formalAfter >= 2) {
    patterns.push("casualize_tone");
  }

  return patterns;
}

/**
 * Get pattern frequency across all diffs.
 * Returns patterns sorted by frequency (most common first).
 */
export async function getPatternFrequency(
  dataDir?: string,
): Promise<Array<{ pattern: string; count: number }>> {
  const diffs = await listDiffs(undefined, dataDir);
  const freq = new Map<string, number>();

  for (const diff of diffs) {
    for (const p of diff.patterns) {
      freq.set(p, (freq.get(p) || 0) + 1);
    }
  }

  return Array.from(freq.entries())
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);
}
