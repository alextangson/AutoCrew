import type { CommandDef } from "./index.js";
import { getOption } from "./index.js";

export const cmd: CommandDef = {
  name: "intel",
  description: "Manage the intel pipeline — pull signals, list saved intel, clean expired items",
  usage: "autocrew intel pull [--source X] | autocrew intel list [--domain X] | autocrew intel clean",
  action: async (args, runner) => {
    const subcommand = args[0];
    if (!subcommand || !["pull", "list", "clean"].includes(subcommand)) {
      console.error("Usage: autocrew intel <pull|list|clean>");
      process.exitCode = 1;
      return;
    }

    const result = await runner.execute("autocrew_intel", {
      action: subcommand,
      source: getOption(args, "--source"),
      domain: getOption(args, "--domain"),
    });

    if (!result.ok) {
      console.error(`Intel ${subcommand} failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    switch (subcommand) {
      case "pull":
        console.log(`Intel pull complete. Collected: ${result.totalCollected}, Saved: ${result.totalSaved}`);
        if (result.bySource) {
          for (const [src, count] of Object.entries(result.bySource as Record<string, number>)) {
            console.log(`  ${src}: ${count}`);
          }
        }
        if (result.errors) {
          console.log(`  Errors: ${(result.errors as string[]).length}`);
        }
        break;

      case "list": {
        console.log(`Intel items: ${result.total} total, showing ${result.showing}`);
        const items = (result.items || []) as any[];
        for (const item of items) {
          console.log(`  [${item.source}] ${item.title} — relevance: ${item.relevance ?? "?"}`);
        }
        break;
      }

      case "clean":
        console.log(`Intel clean complete. Archived: ${result.archived}`);
        break;
    }
  },
};
