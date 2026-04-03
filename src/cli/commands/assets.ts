import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "assets",
  description: "List assets for a content project",
  usage: "autocrew assets <content-id>",
  action: async (args, runner) => {
    const contentId = args[0];
    if (!contentId) {
      console.error("Usage: autocrew assets <content-id>");
      process.exitCode = 1;
      return;
    }
    const result = await runner.execute("autocrew_asset", { action: "list", content_id: contentId });
    const assets = (result.assets || []) as any[];
    if (assets.length === 0) {
      console.log(`No assets for ${contentId}.`);
      return;
    }
    for (const a of assets) {
      console.log(`  [${a.type}] ${a.filename} (${a.role || "general"})`);
    }
  },
};
