import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "templates",
  description: "List available pipeline templates",
  usage: "autocrew templates",
  action: async (_args, runner) => {
    const result = await runner.execute("autocrew_pipeline", { action: "templates" });
    const templates = (result.templates || []) as any[];
    for (const t of templates) {
      console.log(`  [${t.id}] ${t.name}`);
      console.log(`    ${t.description}`);
    }
  },
};
