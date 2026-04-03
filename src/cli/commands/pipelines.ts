import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "pipelines",
  description: "List configured pipelines",
  usage: "autocrew pipelines",
  action: async (_args, runner) => {
    const result = await runner.execute("autocrew_pipeline", { action: "list" });
    const pipelines = (result.pipelines || []) as any[];
    if (pipelines.length === 0) {
      console.log("No pipelines configured. Use 'autocrew_pipeline' tool to create one.");
      return;
    }
    for (const p of pipelines) {
      console.log(`  [${p.id}] ${p.name} — ${p.enabled ? "enabled" : "disabled"} (${p.schedule || "manual"})`);
    }
  },
};
