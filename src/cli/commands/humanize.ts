import type { CommandDef } from "./index.js";
import { resolveProjectText } from "./index.js";

export const cmd: CommandDef = {
  name: "humanize",
  description: "Run Chinese de-AI pass on a content draft",
  usage: "autocrew humanize <content-id-or-project-slug> [--file <path>]",
  action: async (args, runner) => {
    const id = args[0];
    if (!id && !args.includes("--file")) {
      console.error("Usage: autocrew humanize <content-id-or-project-slug> [--file <path>]");
      process.exitCode = 1;
      return;
    }

    const resolved = await resolveProjectText(id, args);
    if (!resolved) {
      console.error(`Not found: "${id}". Provide a content ID, pipeline project slug, or --file <path>.`);
      process.exitCode = 1;
      return;
    }

    const result = await runner.execute("autocrew_humanize", {
      action: "humanize_zh",
      text: resolved.text,
    });

    if (!result.ok) {
      console.error(`Humanize failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`De-AI pass complete for "${resolved.title}" (${resolved.source})`);
    console.log(`Changes: ${result.changeCount || 0}`);
    if ((result.changes as any[])?.length > 0) {
      for (const c of result.changes as string[]) {
        console.log(`  • ${c}`);
      }
    }
  },
};
