import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "start",
  description: "Start a new project from a topic",
  usage: "autocrew start <topic>",
  action: async (args, runner) => {
    const topic = args[0];
    if (!topic) {
      console.error("Usage: autocrew start <topic>");
      process.exitCode = 1;
      return;
    }

    const result = await runner.execute("autocrew_pipeline_ops", {
      action: "start",
      project: topic,
    });

    if (!result.ok) {
      console.error(`Start failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Project started: ${result.projectDir}`);
  },
};
