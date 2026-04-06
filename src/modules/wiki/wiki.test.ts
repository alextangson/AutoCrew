import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  initPipeline,
  saveIntel,
  saveWikiPage,
  getWikiPage,
  listWikiPages,
  regenerateWikiIndex,
  appendWikiLog,
  stagePath,
  type IntelItem,
  type WikiPage,
} from "../../storage/pipeline-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-wiki-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("Wiki Integration", () => {
  it("full lifecycle: save intel → create wiki page → regenerate index → log", async () => {
    await initPipeline(testDir);

    // 1. Save two related intel items about the same entity
    const intel1: IntelItem = {
      title: "Cursor reaches 2.6B valuation",
      domain: "ai-tools",
      source: "web_search",
      collectedAt: new Date().toISOString(),
      relevance: 85,
      tags: ["cursor", "funding"],
      expiresAfter: 90,
      summary: "Anysphere's Cursor editor valued at $2.6B",
      keyPoints: ["VS Code fork", "$2.6B valuation", "AI-first editor"],
      topicPotential: "AI tool funding trends",
    };
    const intel2: IntelItem = {
      title: "Cursor Agent Mode launches",
      domain: "ai-tools",
      source: "web_search",
      collectedAt: new Date().toISOString(),
      relevance: 80,
      tags: ["cursor", "agent"],
      expiresAfter: 90,
      summary: "Cursor launches agent mode for autonomous coding",
      keyPoints: ["Agent mode", "Autonomous coding", "Background tasks"],
      topicPotential: "AI coding evolution",
    };
    await saveIntel(intel1, testDir);
    await saveIntel(intel2, testDir);

    // 2. Create a wiki page synthesizing both
    const today = new Date().toISOString().slice(0, 10);
    const page: WikiPage = {
      type: "entity",
      title: "Cursor",
      aliases: ["Cursor AI", "Cursor Editor"],
      related: [],
      sources: [
        `ai-tools/${today}-cursor-reaches-2-6b-valuation.md`,
        `ai-tools/${today}-cursor-agent-mode-launches.md`,
      ],
      created: today,
      updated: today,
      body: "# Cursor\n\nAI code editor by Anysphere.\n\n## Key Facts\n- VS Code fork with integrated AI\n- $2.6B valuation (2024)\n- Agent Mode for autonomous coding",
    };
    await saveWikiPage(page, testDir);

    // 3. Verify page saved correctly
    const loaded = await getWikiPage("cursor", testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Cursor");
    expect(loaded!.sources).toHaveLength(2);
    expect(loaded!.aliases).toContain("Cursor AI");

    // 4. Regenerate index
    await regenerateWikiIndex(testDir);
    const indexContent = await fs.readFile(
      path.join(stagePath("wiki", testDir), "index.md"),
      "utf-8",
    );
    expect(indexContent).toContain("[Cursor]");
    expect(indexContent).toContain("## Entities");

    // 5. Log the sync
    await appendWikiLog("sync", "Created cursor.md from 2 intel sources", testDir);
    const logContent = await fs.readFile(
      path.join(stagePath("wiki", testDir), "log.md"),
      "utf-8",
    );
    expect(logContent).toContain("sync");
    expect(logContent).toContain("cursor.md");

    // 6. Verify flat structure — no subdirectories
    const wikiFiles = await fs.readdir(stagePath("wiki", testDir));
    expect(wikiFiles).toContain("cursor.md");
    expect(wikiFiles).toContain("index.md");
    expect(wikiFiles).toContain("log.md");
    for (const f of wikiFiles) {
      const stat = await fs.stat(path.join(stagePath("wiki", testDir), f));
      expect(stat.isFile()).toBe(true);
    }
  });

  it("multiple pages across types with cross-references", async () => {
    await initPipeline(testDir);
    const today = new Date().toISOString().slice(0, 10);

    await saveWikiPage({
      type: "entity",
      title: "Cursor",
      aliases: ["Cursor AI"],
      related: ["vibe-coding"],
      sources: [],
      created: today,
      updated: today,
      body: "# Cursor\n\nAI code editor.",
    }, testDir);

    await saveWikiPage({
      type: "concept",
      title: "Vibe Coding",
      aliases: ["vibe coding"],
      related: ["cursor"],
      sources: [],
      created: today,
      updated: today,
      body: "# Vibe Coding\n\nNatural language programming.",
    }, testDir);

    const pages = await listWikiPages(testDir);
    expect(pages).toHaveLength(2);

    await regenerateWikiIndex(testDir);
    const indexContent = await fs.readFile(
      path.join(stagePath("wiki", testDir), "index.md"),
      "utf-8",
    );
    expect(indexContent).toContain("## Entities");
    expect(indexContent).toContain("## Concepts");
    expect(indexContent).toContain("[Cursor]");
    expect(indexContent).toContain("[Vibe Coding]");
  });
});
