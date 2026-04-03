import type { CommandDef } from "./index.js";
import { getOption } from "./index.js";

export const cmd: CommandDef = {
  name: "research",
  description: "Discover browser-first topic candidates and save them into AutoCrew",
  usage: "autocrew research --keyword <keyword> [--industry <industry>] [--platform <platform>] [--count <count>]",
  action: async (args, runner) => {
    const keyword = getOption(args, "--keyword");
    if (!keyword) {
      console.error("Missing required option: --keyword <keyword>");
      process.exitCode = 1;
      return;
    }

    const result = await runner.execute("autocrew_research", {
      action: "discover",
      keyword,
      industry: getOption(args, "--industry"),
      platform: getOption(args, "--platform") || "xiaohongshu",
      topic_count: Number(getOption(args, "--count") || 3),
    });

    if (!result.ok) {
      console.error(`Research failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Research complete. Mode: ${result.mode}`);
    const topics = (result.topics || []) as any[];
    for (const t of topics) {
      console.log(`  [${t.id}] ${t.title} — score: ${t.viralScore ?? "?"}`);
    }
  },
};
