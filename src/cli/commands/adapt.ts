import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "adapt",
  description: "Create a platform-native rewrite",
  usage: "autocrew adapt <content-id> <platform>",
  action: async (args, runner) => {
    const contentId = args[0];
    const platform = args[1];
    if (!contentId || !platform) {
      console.error("Usage: autocrew adapt <content-id> <platform>");
      process.exitCode = 1;
      return;
    }
    const result = await runner.execute("autocrew_rewrite", {
      action: "adapt_platform",
      content_id: contentId,
      target_platform: platform,
    });
    if (!result.ok) {
      console.error(`Adapt failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Platform rewrite complete → ${platform}`);
    console.log(`  New content: ${result.newContentId || result.id || "(saved)"}`);
  },
};
