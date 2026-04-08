import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "versions",
  description: "List version history for a content project (draft versions + asset versions)",
  usage: "autocrew versions <project-slug-or-content-id>",
  action: async (args, runner) => {
    const id = args[0];
    if (!id) {
      console.error("Usage: autocrew versions <project-slug-or-content-id>");
      process.exitCode = 1;
      return;
    }

    // Try pipeline project first (draft versions from meta.yaml)
    try {
      const { getProjectMeta, syncUntrackedChanges } = await import("../../storage/pipeline-store.js");

      // Auto-detect manual edits to draft.md before reading versions
      const syncResult = await syncUntrackedChanges(id);
      if (syncResult.synced) {
        console.log(`  (detected external edit: ${syncResult.reason})`);
      }

      const meta = await getProjectMeta(id);
      if (meta) {
        console.log(`Draft versions for "${meta.title}":`);
        console.log(`  Current: ${meta.current}`);
        if (meta.versions.length === 0) {
          console.log("  No revision history yet (initial draft only).");
        } else {
          for (const v of meta.versions) {
            console.log(`  ${v.file} — ${v.note} (${v.createdAt})`);
          }
        }
        console.log(`  Stage: ${meta.history.at(-1)?.stage ?? "unknown"}`);
        return;
      }
    } catch {
      // Pipeline store may not be available
    }

    // Fallback to asset versions (legacy)
    const result = await runner.execute("autocrew_asset", { action: "versions", content_id: id });
    const versions = (result.versions || []) as any[];
    if (versions.length === 0) {
      console.log(`No versions found for "${id}". Check the project slug or content ID.`);
      return;
    }
    console.log(`Asset versions for ${id}:`);
    for (const v of versions) {
      console.log(`  v${v.version} — ${v.note || "no note"} (${v.savedAt})`);
    }
  },
};
