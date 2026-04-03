import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "restore",
  description: "Restore a project from the trash stage",
  usage: "autocrew restore <project>",
  action: async (args, runner) => {
    const project = args[0];
    if (!project) {
      console.error("Usage: autocrew restore <project>");
      process.exitCode = 1;
      return;
    }

    const result = await runner.execute("autocrew_pipeline_ops", {
      action: "restore",
      project,
    });

    if (!result.ok) {
      console.error(`Restore failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Project restored to: ${result.restoredTo}`);
  },
};
