import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "versions",
  description: "List version history for a content project",
  usage: "autocrew versions <content-id>",
  action: async (args, runner) => {
    const contentId = args[0];
    if (!contentId) {
      console.error("Usage: autocrew versions <content-id>");
      process.exitCode = 1;
      return;
    }
    const result = await runner.execute("autocrew_asset", { action: "versions", content_id: contentId });
    const versions = (result.versions || []) as any[];
    if (versions.length === 0) {
      console.log(`No versions for ${contentId}.`);
      return;
    }
    for (const v of versions) {
      console.log(`  v${v.version} — ${v.note || "no note"} (${v.savedAt})`);
    }
  },
};
