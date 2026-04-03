import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "status",
  description: "Show pipeline status",
  usage: "autocrew status",
  action: async (_args, runner, ctx) => {
    const result = await runner.execute("autocrew_status", {});
    console.log(`AutoCrew v${result.version}`);
    console.log(`Data: ${ctx.dataDir}`);
    console.log(`Topics: ${result.topics}`);
    console.log(`Contents: ${result.contents} (draft:${(result.contentsByStatus as any)?.draft ?? 0} review:${(result.contentsByStatus as any)?.review ?? 0} approved:${(result.contentsByStatus as any)?.approved ?? 0} published:${(result.contentsByStatus as any)?.published ?? 0})`);
  },
};
