import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "cover",
  description: "Cover operations: review candidates or approve a variant",
  usage: "autocrew cover <content-id> [--approve <label>]",
  action: async (args, runner) => {
    const contentId = args[0];
    if (!contentId) {
      console.error("Usage: autocrew cover <content-id> [--approve <label>]");
      process.exitCode = 1;
      return;
    }

    // Check for --approve flag → approve-cover flow
    const approveIdx = args.indexOf("--approve");
    if (approveIdx !== -1) {
      const label = args[approveIdx + 1];
      if (!label) {
        console.error("Usage: autocrew cover <content-id> --approve <label>");
        process.exitCode = 1;
        return;
      }
      const result = await runner.execute("autocrew_cover_review", {
        action: "approve",
        content_id: contentId,
        label,
      });
      if (!result.ok) {
        console.error(`Approve failed: ${result.error || "unknown error"}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Cover ${label.toUpperCase()} approved for ${contentId}.`);
      return;
    }

    // Default: cover-review flow
    const result = await runner.execute("autocrew_cover_review", {
      action: "create_candidates",
      content_id: contentId,
    });
    if (!result.ok) {
      console.error(`Cover generation failed: ${result.error || "unknown error"}`);
      if (result.hint) console.log(`Hint: ${result.hint}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Generated ${result.generated || 0} cover candidates.`);
    const review = result.review as any;
    if (review?.variants) {
      for (const v of review.variants) {
        console.log(`  [${v.label.toUpperCase()}] ${v.style} — ${v.titleText || ""}`);
        if (v.imagePaths?.["3:4"]) console.log(`    → ${v.imagePaths["3:4"]}`);
      }
    }
  },
};
