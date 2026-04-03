import type { CommandDef } from "./index.js";
import { getOption } from "./index.js";

export const cmd: CommandDef = {
  name: "review",
  description: "Run full content review or auto-fix (use --fix for auto-fix mode)",
  usage: "autocrew review <content-id> [--platform <platform>] [--fix]",
  action: async (args, runner) => {
    const contentId = args[0];
    if (!contentId) {
      console.error("Usage: autocrew review <content-id> [--platform <platform>] [--fix]");
      process.exitCode = 1;
      return;
    }

    const platform = getOption(args, "--platform");
    const isFix = args.includes("--fix");

    if (isFix) {
      // auto-fix mode
      const result = await runner.execute("autocrew_review", {
        action: "auto_fix",
        content_id: contentId,
        platform,
      });

      if (!result.ok) {
        console.error(`Fix failed: ${result.error || "unknown error"}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Auto-fix complete for ${contentId}.`);
      console.log(`  Sensitive words fixed: ${result.sensitiveWordsFixed || 0}`);
      console.log(`  AI traces fixed: ${result.aiFixesApplied || 0}`);
      console.log(`  Saved: ${result.saved ? "yes" : "no"}`);
      return;
    }

    // full review mode
    const result = await runner.execute("autocrew_review", {
      action: "full_review",
      content_id: contentId,
      platform,
    }) as any;

    if (!result.ok) {
      console.error(`Review failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(result.summary);
    if (result.fixes?.length > 0) {
      console.log("\nSuggested fixes:");
      for (const fix of result.fixes) {
        console.log(`  ${fix}`);
      }
    }
  },
};
