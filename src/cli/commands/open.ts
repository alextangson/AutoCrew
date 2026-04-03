import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "open",
  description: "Show the file path of a content project directory",
  usage: "autocrew open <content-id>",
  action: async (args, _runner, ctx) => {
    const contentId = args[0];
    if (!contentId) {
      console.error("Usage: autocrew open <content-id>");
      process.exitCode = 1;
      return;
    }
    const projPath = `${ctx.dataDir}/contents/${contentId}`;
    console.log(`Content project: ${projPath}`);
    console.log(`  draft.md    — current readable draft`);
    console.log(`  meta.json   — metadata + asset index`);
    console.log(`  assets/     — media files (covers, B-Roll, etc.)`);
    console.log(`  versions/   — version history (v1.md, v2.md, ...)`);
  },
};
