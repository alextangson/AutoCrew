import { Type } from "@sinclair/typebox";
import { loadProfile } from "../modules/profile/creator-profile.js";
import { runIntelPull } from "../modules/intel/intel-engine.js";
import { listIntel, archiveExpiredIntel } from "../storage/pipeline-store.js";

export const intelSchema = Type.Object({
  action: Type.Unsafe<string>({
    type: "string",
    enum: ["pull", "list", "clean"],
    description: "Action to perform: pull (collect intel), list (show saved intel), clean (archive expired)",
  }),
  domain: Type.Optional(Type.String({ description: "Filter by domain" })),
  source: Type.Optional(Type.String({ description: "Filter to specific source(s), comma-separated" })),
  keywords: Type.Optional(Type.Array(Type.String(), { description: "Override keywords for pull" })),
  _dataDir: Type.Optional(Type.String()),
});

export async function executeIntel(params: Record<string, unknown>) {
  const action = params.action as string;
  const dataDir = (params._dataDir as string) || undefined;
  const domain = (params.domain as string) || undefined;

  switch (action) {
    case "pull": {
      const profile = await loadProfile(dataDir);
      if (!profile) {
        return { ok: false, error: "No creator profile found. Run autocrew_init first." };
      }

      const searchFn = params._searchFn as
        | ((query: string) => Promise<Array<{ title: string; snippet: string; url: string }>>)
        | undefined;
      if (!searchFn) {
        return { ok: false, error: "Search function not available. Ensure MCP search is configured." };
      }

      const keywords = (params.keywords as string[]) ?? profile.writingRules.map((r) => r.rule).slice(0, 5);
      const sources = params.source ? (params.source as string).split(",").map((s) => s.trim()) : undefined;

      const result = await runIntelPull({
        keywords: keywords.length > 0 ? keywords : [profile.industry],
        industry: profile.industry,
        platforms: profile.platforms,
        dataDir,
        searchFn,
        skipBrowser: true,
        sources,
      });

      return {
        ok: true,
        action: "pull",
        totalCollected: result.totalCollected,
        totalSaved: result.totalSaved,
        bySource: result.bySource,
        errors: result.errors.length > 0 ? result.errors.slice(0, 10) : undefined,
      };
    }

    case "list": {
      const items = await listIntel(domain, dataDir);
      const top50 = items.slice(0, 50).map((item) => ({
        title: item.title,
        domain: item.domain,
        source: item.source,
        relevance: item.relevance,
        collectedAt: item.collectedAt,
        summary: item.summary.slice(0, 120),
      }));

      return {
        ok: true,
        action: "list",
        total: items.length,
        showing: top50.length,
        items: top50,
      };
    }

    case "clean": {
      const result = await archiveExpiredIntel(dataDir);
      return {
        ok: true,
        action: "clean",
        archived: result.archived,
      };
    }

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}
