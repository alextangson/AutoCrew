import type { CommandDef } from "./index.js";
import { getOption } from "./index.js";

export const cmd: CommandDef = {
  name: "learn",
  description: "Capture a feedback signal into AutoCrew memory",
  usage: "autocrew learn <content-id> --signal <signal> [--feedback <feedback>] [--modified-text <text>]",
  action: async (args, runner) => {
    const contentId = args[0];
    const signal = getOption(args, "--signal");
    if (!contentId || !signal) {
      console.error("Usage: autocrew learn <content-id> --signal <signal> [--feedback <feedback>]");
      process.exitCode = 1;
      return;
    }

    const result = await runner.execute("autocrew_memory", {
      action: "capture_feedback",
      content_id: contentId,
      signal_type: signal,
      feedback: getOption(args, "--feedback"),
      modified_text: getOption(args, "--modified-text"),
    });

    if (!result.ok) {
      console.error(`Memory capture failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Saved learning to ${result.section}.`);
    console.log(`  ${result.learning}`);
  },
};
