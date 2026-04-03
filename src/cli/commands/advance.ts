import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "advance",
  description: "Advance a project to the next pipeline stage",
  usage: "autocrew advance <project>",
  action: async (args, runner) => {
    const project = args[0];
    if (!project) {
      console.error("Usage: autocrew advance <project>");
      process.exitCode = 1;
      return;
    }

    const result = await runner.execute("autocrew_pipeline_ops", {
      action: "advance",
      project,
    });

    if (!result.ok) {
      console.error(`Advance failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Project advanced to: ${result.newDir}`);
  },
};
