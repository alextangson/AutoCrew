import type { CommandDef } from "./index.js";
import { resolveProjectText } from "./index.js";

export const cmd: CommandDef = {
  name: "pre-publish",
  description: "Run pre-publish checklist: 6 checks before allowing publish",
  usage: "autocrew pre-publish <content-id-or-project-slug> [--file <path>]",
  action: async (args, runner) => {
    const id = args[0];
    if (!id && !args.includes("--file")) {
      console.error("Usage: autocrew pre-publish <id-or-slug> [--file <path>]");
      process.exitCode = 1;
      return;
    }

    const resolved = await resolveProjectText(id, args);
    if (!resolved) {
      console.error(`Not found: "${id}". Provide a content ID, pipeline project slug, or --file <path>.`);
      process.exitCode = 1;
      return;
    }

    // Try with content_id first (legacy), fall back to text-based check
    let result: any;
    if (resolved.source.startsWith("content:")) {
      const contentId = resolved.source.replace("content:", "");
      result = await runner.execute("autocrew_pre_publish", {
        action: "check",
        content_id: contentId,
      });
    } else {
      // Pipeline project or file — use text-based review as proxy
      result = await runner.execute("autocrew_review", {
        action: "full_review",
        text: resolved.text,
      });
    }

    if (!result.ok) {
      console.error(`Pre-publish check failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Pre-publish check for "${resolved.title}" (${resolved.source}):`);
    console.log(result.summary || "Check complete.");
  },
};
