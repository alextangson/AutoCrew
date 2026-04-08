import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "contents",
  description: "List content items (legacy + pipeline projects)",
  usage: "autocrew contents",
  action: async (_args, runner) => {
    const result = await runner.execute("autocrew_content", { action: "list" });

    // Legacy contents (local-store)
    const contents = (result.contents || result.items || []) as any[];
    // Pipeline projects (drafting/production/published)
    const pipelineProjects = (result.pipelineProjects || []) as any[];

    if (contents.length === 0 && pipelineProjects.length === 0) {
      console.log("No content yet. Use autocrew_content action='save' to create drafts.");
      return;
    }

    if (contents.length > 0) {
      console.log("Legacy contents:");
      for (const c of contents) {
        console.log(`  [${c.id}] ${c.title} — ${c.status} (${c.platform || "general"})`);
      }
    }

    if (pipelineProjects.length > 0) {
      if (contents.length > 0) console.log("");
      console.log("Pipeline projects:");
      for (const p of pipelineProjects) {
        console.log(`  [${p.slug}] ${p.title} — ${p.stage} (${p.current})`);
      }
    }
  },
};
