/**
 * CLI command router — parses argv and dispatches to the matching command.
 */
import { createRequire } from "node:module";
import { commands } from "./commands/index.js";
import { showBanner } from "./banner.js";
import type { ToolRunner } from "../runtime/tool-runner.js";
import type { ToolContext } from "../runtime/context.js";
import type { EventBus } from "../runtime/events.js";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../../package.json");

export async function run(argv: string[], runner: ToolRunner, ctx: ToolContext, eventBus: EventBus): Promise<void> {
  const subcommand = argv[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    showBanner(VERSION);
    console.log("Usage: autocrew <command> [options]\n");
    console.log("Commands:");
    for (const cmd of commands) {
      console.log(`  ${cmd.name.padEnd(20)} ${cmd.description}`);
    }
    console.log("\nRun 'autocrew <command> --help' for more info.");
    return;
  }

  if (subcommand === "--version" || subcommand === "-v") {
    console.log(VERSION);
    return;
  }

  const cmd = commands.find(c => c.name === subcommand);
  if (!cmd) {
    console.error(`Unknown command: ${subcommand}`);
    console.error("Run 'autocrew --help' for available commands.");
    process.exitCode = 1;
    return;
  }

  await cmd.action(argv.slice(1), runner, ctx, eventBus);
}
