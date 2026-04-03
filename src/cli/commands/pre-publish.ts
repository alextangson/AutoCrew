import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "pre-publish",
  description: "Run pre-publish checklist: 6 checks before allowing publish",
  usage: "autocrew pre-publish <content-id>",
  action: async (args, runner) => {
    const contentId = args[0];
    if (!contentId) {
      console.error("Usage: autocrew pre-publish <content-id>");
      process.exitCode = 1;
      return;
    }
    const result = await runner.execute("autocrew_pre_publish", {
      action: "check",
      content_id: contentId,
    }) as any;

    if (!result.ok) {
      console.error(`Pre-publish check failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(result.summary);
  },
};
