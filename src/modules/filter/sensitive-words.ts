/**
 * Sensitive Words Filter — scans text for sensitive/restricted words
 *
 * Sources:
 * 1. Built-in word list: src/data/sensitive-words-builtin.json
 * 2. User custom list:   ~/.autocrew/sensitive-words/custom.txt (one word per line)
 * 3. Platform-specific restricted words with replacement suggestions
 */
import fs from "node:fs/promises";
import path from "node:path";

// --- Types ---

export interface ScanHit {
  word: string;
  category: string;
  /** Suggested replacement (if available) */
  suggestion?: string;
  /** All positions where this word appears */
  positions: number[];
}

export interface ScanResult {
  ok: boolean;
  /** Total number of distinct sensitive words found */
  hitCount: number;
  /** Detailed hits */
  hits: ScanHit[];
  /** Quick summary for display */
  summary: string;
  /** Auto-fixed text (with suggestions applied) */
  autoFixedText?: string;
}

interface BuiltinData {
  categories: Record<string, { description: string; words: string[] }>;
  platform_specific: Record<
    string,
    {
      description: string;
      restricted: string[];
      suggestions?: Record<string, string>;
    }
  >;
}

// --- Loader ---

let _builtinCache: BuiltinData | null = null;

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadBuiltin(): Promise<BuiltinData> {
  if (_builtinCache) return _builtinCache;
  const filePath = path.resolve(__dirname, "../../data/sensitive-words-builtin.json");
  const raw = await fs.readFile(filePath, "utf-8");
  _builtinCache = JSON.parse(raw) as BuiltinData;
  return _builtinCache;
}

async function loadCustomWords(dataDir?: string): Promise<string[]> {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  const customPath = path.join(dataDir || path.join(home, ".autocrew"), "sensitive-words", "custom.txt");
  try {
    const raw = await fs.readFile(customPath, "utf-8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

// --- Core scan ---

/**
 * Scan text for sensitive words.
 * @param text - The text to scan
 * @param platform - Optional platform for platform-specific checks
 * @param dataDir - Optional custom data directory
 */
export async function scanText(
  text: string,
  platform?: string,
  dataDir?: string,
): Promise<ScanResult> {
  if (!text || !text.trim()) {
    return { ok: true, hitCount: 0, hits: [], summary: "空文本，无需检查" };
  }

  const builtin = await loadBuiltin();
  const customWords = await loadCustomWords(dataDir);
  const hits: ScanHit[] = [];

  // 1. Scan built-in categories
  for (const [category, data] of Object.entries(builtin.categories)) {
    for (const word of data.words) {
      const positions = findAllPositions(text, word);
      if (positions.length > 0) {
        hits.push({ word, category, positions });
      }
    }
  }

  // 2. Scan platform-specific restricted words
  if (platform && builtin.platform_specific[platform]) {
    const platformData = builtin.platform_specific[platform];
    for (const word of platformData.restricted) {
      const positions = findAllPositions(text, word);
      if (positions.length > 0) {
        const suggestion = platformData.suggestions?.[word];
        hits.push({
          word,
          category: `platform:${platform}`,
          suggestion,
          positions,
        });
      }
    }
  }

  // 3. Scan custom words
  for (const word of customWords) {
    const positions = findAllPositions(text, word);
    if (positions.length > 0) {
      hits.push({ word, category: "custom", positions });
    }
  }

  // Deduplicate by word
  const deduped = deduplicateHits(hits);

  // Build auto-fixed text
  let autoFixedText: string | undefined;
  const fixableHits = deduped.filter((h) => h.suggestion);
  if (fixableHits.length > 0) {
    autoFixedText = text;
    for (const hit of fixableHits) {
      autoFixedText = autoFixedText.replaceAll(hit.word, hit.suggestion!);
    }
  }

  const summary = buildSummary(deduped);

  return {
    ok: deduped.length === 0,
    hitCount: deduped.length,
    hits: deduped,
    summary,
    autoFixedText,
  };
}

// --- Helpers ---

function findAllPositions(text: string, word: string): number[] {
  const positions: number[] = [];
  const lower = text.toLowerCase();
  const target = word.toLowerCase();
  let idx = lower.indexOf(target);
  while (idx !== -1) {
    positions.push(idx);
    idx = lower.indexOf(target, idx + 1);
  }
  return positions;
}

function deduplicateHits(hits: ScanHit[]): ScanHit[] {
  const map = new Map<string, ScanHit>();
  for (const hit of hits) {
    const existing = map.get(hit.word);
    if (existing) {
      // Merge positions, keep first category
      existing.positions = [...new Set([...existing.positions, ...hit.positions])];
      if (!existing.suggestion && hit.suggestion) {
        existing.suggestion = hit.suggestion;
      }
    } else {
      map.set(hit.word, { ...hit });
    }
  }
  return Array.from(map.values());
}

function buildSummary(hits: ScanHit[]): string {
  if (hits.length === 0) return "✅ 未检测到敏感词";

  const byCat = new Map<string, number>();
  for (const h of hits) {
    byCat.set(h.category, (byCat.get(h.category) || 0) + 1);
  }

  const parts: string[] = [];
  for (const [cat, count] of byCat) {
    parts.push(`${cat}: ${count} 个`);
  }

  const fixable = hits.filter((h) => h.suggestion).length;
  const fixNote = fixable > 0 ? `，其中 ${fixable} 个可自动替换` : "";

  return `⚠️ 检测到 ${hits.length} 个敏感词（${parts.join("、")}）${fixNote}`;
}

/** Reset the built-in cache (for testing) */
export function _resetCache(): void {
  _builtinCache = null;
}
