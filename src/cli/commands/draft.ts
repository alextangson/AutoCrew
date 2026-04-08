import type { CommandDef } from "./index.js";
import { getOption } from "./index.js";

export const cmd: CommandDef = {
  name: "draft",
  description: "Generate a content draft from a topic (loads style + methodology + wiki)",
  usage: "autocrew draft <topic-title> [--platform <platform>]",
  action: async (args, runner) => {
    const topicTitle = args.filter((a) => !a.startsWith("--")).join(" ");
    if (!topicTitle) {
      console.error("Usage: autocrew draft <topic-title> [--platform <platform>]");
      console.error("Example: autocrew draft 'vibe-coding 实践者的真实工作流' --platform xiaohongshu");
      process.exitCode = 1;
      return;
    }

    const platform = getOption(args, "--platform") || "xiaohongshu";

    const result = await runner.execute("autocrew_content", {
      action: "draft",
      topic_title: topicTitle,
      platform,
    });

    if (!result.ok) {
      console.error(`Draft failed: ${result.error || "unknown error"}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Draft context loaded for: "${topicTitle}" (${platform})`);
    console.log(`\nCreator: ${(result.creatorContext as any)?.industry || "not configured"}`);
    console.log(`Style: ${(result.style as string)?.slice(0, 80) || "no style file"}...`);
    console.log(`Wiki context: ${(result.wikiContext as string)?.slice(0, 80) || "none"}...`);
    console.log(`\nWriting instructions loaded (Operating System + Two-Phase Creation).`);
    console.log(`\nNext step: Generate the draft body, then save with:`);
    console.log(`  autocrew_content action="save" title="..." body="..." platform="${platform}"`);
  },
};
