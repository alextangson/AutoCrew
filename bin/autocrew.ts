#!/usr/bin/env node
import { bootstrap } from "../src/cli/bootstrap.js";
import { run } from "../src/cli/index.js";
import { showBanner } from "../src/cli/banner.js";

const { runner, ctx, eventBus } = bootstrap();

// Show banner for interactive use (not for subcommands that pipe output)
if (process.argv.length <= 2 && process.stdout.isTTY) {
  showBanner("0.1.0");
}

await run(process.argv.slice(2), runner, ctx, eventBus);
