import type { CommandDef } from "./index.js";
import { getOption, resolveProjectText } from "./index.js";

export const cmd: CommandDef = {
  name: "review",
  description: "Run full content review or auto-fix",
  usage: "autocrew review <id-or-slug> [--platform <p>] [--fix] [--dry-run] [--file <path>]",
  action: async (args, runner) => {
    const id = args[0];
    if (!id && !args.includes("--file")) {
      console.error("Usage: autocrew review <id-or-slug> [--platform <p>] [--fix] [--file <path>]");
      process.exitCode = 1;
      return;
    }

    const platform = getOption(args, "--platform");
    const isFix = args.includes("--fix");
    const isDryRun = args.includes("--dry-run");

    const resolved = await resolveProjectText(id, args);
    if (!resolved) {
      console.error(`Not found: "${id}". Provide a content ID, pipeline project slug, or --file <path>.`);
      process.exitCode = 1;
      return;
    }

    if (isFix || isDryRun) {
      const result = await runner.execute("autocrew_review", {
        action: "auto_fix",
        text: resolved.text,
        platform,
      });

      if (!result.ok) {
        console.error(`Fix failed: ${result.error || "unknown error"}`);
        process.exitCode = 1;
        return;
      }

      const fixedText = (result.autoFixedText || result.fixedText || "") as string;
      console.log(`  Sensitive words fixed: ${result.sensitiveWordsFixed || 0}`);
      console.log(`  AI traces fixed: ${result.aiFixesApplied || 0}`);

      // Show diff preview
      if (fixedText && fixedText !== resolved.text) {
        // Simple line-by-line diff
        const origLines = resolved.text.split("\n");
        const fixedLines = fixedText.split("\n");
        const diffLines: string[] = [];
        const maxLen = Math.max(origLines.length, fixedLines.length);
        for (let i = 0; i < maxLen; i++) {
          const orig = origLines[i] ?? "";
          const fixed = fixedLines[i] ?? "";
          if (orig !== fixed) {
            if (orig) diffLines.push(`  - ${orig}`);
            if (fixed) diffLines.push(`  + ${fixed}`);
          }
        }
        if (diffLines.length > 0) {
          console.log(`\n  Changes preview:`);
          for (const line of diffLines.slice(0, 20)) {
            console.log(line);
          }
          if (diffLines.length > 20) {
            console.log(`  ... and ${diffLines.length - 20} more lines`);
          }
        }
      }

      if (isDryRun) {
        console.log(`\n  (dry-run mode — no files modified)`);
        return;
      }

      // Write fixed text back to source file
      if (fixedText && resolved.source.startsWith("file:")) {
        const fs = await import("node:fs/promises");
        const filePath = resolved.source.replace("file:", "");
        await fs.writeFile(filePath, fixedText, "utf-8");
        console.log(`\n  Saved back to ${filePath}`);
      } else if (fixedText && resolved.source.startsWith("pipeline:")) {
        const fs = await import("node:fs/promises");
        const { findProject } = await import("../../storage/pipeline-store.js");
        const slug = resolved.source.replace("pipeline:", "");
        const found = await findProject(slug);
        if (found) {
          const path = await import("node:path");
          await fs.writeFile(path.join(found.dir, "draft.md"), fixedText, "utf-8");
          console.log(`\n  Saved back to draft.md`);
        }
      }
      return;
    }

    const result = await runner.execute("autocrew_review", {
      action: "full_review",
      text: resolved.text,
      platform,
    }) as any;

    if (!result.ok) {
      console.error(`Review failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Review for "${resolved.title}" (${resolved.source}):`);
    console.log(result.summary);
    if (result.fixes?.length > 0) {
      console.log("\nSuggested fixes:");
      for (const fix of result.fixes) {
        console.log(`  ${fix}`);
      }
    }
  },
};
