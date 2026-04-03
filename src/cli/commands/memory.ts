import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "memory",
  description: "Show current AutoCrew MEMORY.md",
  usage: "autocrew memory",
  action: async (_args, runner) => {
    const result = await runner.execute("autocrew_memory", { action: "get_memory" });

    if (!result.ok) {
      console.error(`Read memory failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(result.content);
  },
};
