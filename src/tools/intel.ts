import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { loadProfile } from "../modules/profile/creator-profile.js";
import { runIntelPull } from "../modules/intel/intel-engine.js";
import { listIntel, archiveExpiredIntel, saveIntel, type IntelItem } from "../storage/pipeline-store.js";

export const intelSchema = Type.Object({
  action: Type.Unsafe<string>({
    type: "string",
    enum: ["pull", "list", "clean", "ingest"],
    description:
      "Action to perform: pull (collect intel), list (show saved intel), clean (archive expired), ingest (manually add url/text/memory)",
  }),
  domain: Type.Optional(Type.String({ description: "Filter by domain" })),
  source: Type.Optional(Type.String({ description: "Filter to specific source(s), comma-separated" })),
  keywords: Type.Optional(Type.Array(Type.String(), { description: "Override keywords for pull" })),
  url: Type.Optional(Type.String({ description: "URL to ingest as intel (ingest action)" })),
  text: Type.Optional(Type.String({ description: "Raw text to ingest as intel (ingest action)" })),
  memory_paths: Type.Optional(
    Type.Array(Type.String(), { description: "Paths to memory dirs to harvest (ingest action)" }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for ingested intel" })),
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
        _triggerSync: result.totalSaved > 0,
        _syncHint: result.totalSaved > 0
          ? "新增情报已入库。请运行 knowledge-sync 同步知识库。"
          : undefined,
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

    case "ingest": {
      const url = params.url as string | undefined;
      const text = params.text as string | undefined;
      const memoryPaths = params.memory_paths as string[] | undefined;
      const tags = (params.tags as string[]) ?? [];
      const now = new Date().toISOString();

      if (text) {
        const item: IntelItem = {
          title: text.slice(0, 60).replace(/\n/g, " "),
          domain: domain ?? "general",
          source: "manual",
          collectedAt: now,
          relevance: 70,
          tags,
          expiresAfter: 365,
          summary: text,
          keyPoints: [],
          topicPotential: "",
        };
        const filePath = await saveIntel(item, dataDir);
        return { ok: true, action: "ingest", mode: "text", saved: true, filePath, _triggerSync: true, _syncHint: "新素材已入库。请运行 knowledge-sync 同步知识库。" };
      }

      if (url) {
        let hostname: string;
        try {
          hostname = new URL(url).hostname;
        } catch {
          hostname = url.slice(0, 40);
        }
        const item: IntelItem = {
          title: `Ingested from ${hostname}`,
          domain: domain ?? "general",
          source: "manual",
          sourceUrl: url,
          collectedAt: now,
          relevance: 60,
          tags,
          expiresAfter: 365,
          summary: `Placeholder for content from ${url}. Fetch and summarize separately.`,
          keyPoints: [],
          topicPotential: "",
        };
        const filePath = await saveIntel(item, dataDir);
        return { ok: true, action: "ingest", mode: "url", saved: true, filePath, _triggerSync: true, _syncHint: "新素材已入库。请运行 knowledge-sync 同步知识库。" };
      }

      if (memoryPaths && memoryPaths.length > 0) {
        let scanned = 0;
        let extracted = 0;
        let skipped = 0;
        const savedPaths: string[] = [];

        for (const memDir of memoryPaths) {
          let files: string[];
          try {
            files = await fs.readdir(memDir);
          } catch {
            skipped++;
            continue;
          }
          for (const f of files) {
            if (!f.endsWith(".md") || f === "MEMORY.md") continue;
            scanned++;
            const filePath = path.join(memDir, f);
            const content = await fs.readFile(filePath, "utf-8");
            if (content.length < 100) {
              skipped++;
              continue;
            }
            const item: IntelItem = {
              title: f.replace(/\.md$/, "").replace(/[-_]/g, " "),
              domain: domain ?? "general",
              source: "manual",
              collectedAt: now,
              relevance: 50,
              tags: [...tags, "memory-harvest"],
              expiresAfter: 730,
              summary: content.slice(0, 500),
              keyPoints: [],
              topicPotential: "",
            };
            const saved = await saveIntel(item, dataDir);
            savedPaths.push(saved);
            extracted++;
          }
        }

        return { ok: true, action: "ingest", mode: "memory", scanned, extracted, skipped, savedPaths, _triggerSync: extracted > 0, _syncHint: extracted > 0 ? "新素材已入库。请运行 knowledge-sync 同步知识库。" : undefined };
      }

      return { ok: false, error: "ingest requires url, text, or memory_paths" };
    }

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}
