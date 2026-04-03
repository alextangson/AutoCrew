import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "humanize",
  description: "Run Chinese de-AI pass on a content draft",
  usage: "autocrew humanize <content-id>",
  action: async (args, runner) => {
    const contentId = args[0];
    if (!contentId) {
      console.error("Usage: autocrew humanize <content-id>");
      process.exitCode = 1;
      return;
    }
    const result = await runner.execute("autocrew_humanize", { content_id: contentId });
    if (!result.ok) {
      console.error(`Humanize failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }
    console.log(`De-AI pass complete. Changes: ${result.changeCount || 0}`);
    if ((result.changes as any[])?.length > 0) {
      for (const c of result.changes as string[]) {
        console.log(`  • ${c}`);
      }
    }
  },
};
