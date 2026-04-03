import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "trash",
  description: "Move a project to the trash stage",
  usage: "autocrew trash <project>",
  action: async (args, runner) => {
    const project = args[0];
    if (!project) {
      console.error("Usage: autocrew trash <project>");
      process.exitCode = 1;
      return;
    }

    const result = await runner.execute("autocrew_pipeline_ops", {
      action: "trash",
      project,
    });

    if (!result.ok) {
      console.error(`Trash failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Project trashed: ${project}`);
  },
};
