import type { IntelItem } from "../../storage/pipeline-store.js";
import { saveIntel } from "../../storage/pipeline-store.js";
import type { Collector, CollectorOptions } from "./collector.js";
import { createWebSearchCollector } from "./collectors/web-search.js";
import type { SearchFn } from "./collectors/web-search.js";
import { createRssCollector } from "./collectors/rss.js";
import { createTrendCollector } from "./collectors/trends.js";
import { createCompetitorCollector } from "./collectors/competitor.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IntelPullOptions {
  keywords: string[];
  industry: string;
  platforms: string[];
  dataDir?: string;
  searchFn: SearchFn;
  skipBrowser?: boolean;
  sources?: string[]; // filter to specific sources
}

export interface IntelPullResult {
  totalCollected: number;
  totalSaved: number;
  bySource: Record<string, number>;
  errors: string[];
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

function buildCollectors(opts: IntelPullOptions): Collector[] {
  const all: Collector[] = [
    createWebSearchCollector(opts.searchFn),
    createRssCollector(),
    createTrendCollector(opts.searchFn),
  ];

  if (!opts.skipBrowser) {
    all.push(createCompetitorCollector());
  }

  if (opts.sources?.length) {
    const allowed = new Set(opts.sources);
    return all.filter((c) => allowed.has(c.id));
  }

  return all;
}

export async function runIntelPull(opts: IntelPullOptions): Promise<IntelPullResult> {
  const collectors = buildCollectors(opts);

  const collectorOpts: CollectorOptions = {
    keywords: opts.keywords,
    industry: opts.industry,
    platforms: opts.platforms,
    dataDir: opts.dataDir,
  };

  const settled = await Promise.allSettled(
    collectors.map((c) => c.collect(collectorOpts)),
  );

  const allItems: IntelItem[] = [];
  const errors: string[] = [];
  const bySource: Record<string, number> = {};

  for (const result of settled) {
    if (result.status === "fulfilled") {
      const { items, source, errors: collectorErrors } = result.value;
      allItems.push(...items);
      bySource[source] = (bySource[source] ?? 0) + items.length;
      errors.push(...collectorErrors);
    } else {
      errors.push(`Collector failed: ${result.reason}`);
    }
  }

  let totalSaved = 0;
  for (const item of allItems) {
    try {
      await saveIntel(item, opts.dataDir);
      totalSaved++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to save "${item.title}": ${msg}`);
    }
  }

  return {
    totalCollected: allItems.length,
    totalSaved,
    bySource,
    errors,
  };
}
