import type { IntelItem } from "../../../storage/pipeline-store.js";
import type { Collector, CollectorOptions, CollectorResult } from "../collector.js";
import type { ResearchItem, BrowserPlatform } from "../../../adapters/browser/types.js";
import { browserCdpAdapter } from "../../../adapters/browser/browser-cdp.js";
import { loadSourceConfig } from "../source-config.js";

// ─── Result Transformer ────────────────────────────────────────────────────

export function transformCompetitorResults(
  results: ResearchItem[],
  accountName: string,
  domain: string,
  platform: string,
): IntelItem[] {
  return results
    .filter((r) => r.title)
    .map((r) => ({
      title: r.title,
      domain,
      source: "competitor" as const,
      sourceUrl: r.url,
      collectedAt: new Date().toISOString(),
      relevance: 60,
      tags: [`competitor:${accountName}`, platform],
      expiresAfter: 14,
      summary: r.summary ?? "",
      keyPoints: [],
      topicPotential: "",
    }));
}

// ─── Competitor Collector ───────────────────────────────────────────────────

export function createCompetitorCollector(): Collector {
  return {
    id: "competitor",
    async collect(opts: CollectorOptions): Promise<CollectorResult> {
      const config = await loadSourceConfig(opts.dataDir);
      const items: IntelItem[] = [];
      const errors: string[] = [];

      for (const account of config.accounts) {
        try {
          const results = await browserCdpAdapter.research({
            platform: account.platform as BrowserPlatform,
            keyword: account.name,
            limit: 10,
          });
          const transformed = transformCompetitorResults(
            results,
            account.name,
            account.domain,
            account.platform,
          );
          items.push(...transformed);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Competitor ${account.name} (${account.platform}) failed: ${msg}`);
        }
      }

      return { items, source: "competitor", errors };
    },
  };
}
