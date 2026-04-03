import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "audit",
  description: "Show recent tool execution audit log",
  usage: "autocrew audit",
  action: async (_args, _runner, ctx) => {
    if (ctx.audit.length === 0) {
      console.log("No audit entries yet.");
      return;
    }
    for (const entry of ctx.audit.slice(-20)) {
      const status = entry.ok ? "\u2713" : "\u2717";
      console.log(`  ${status} ${entry.tool}${entry.action ? `:${entry.action}` : ""} — ${entry.durationMs}ms (${entry.timestamp})`);
      if (entry.error) console.log(`    Error: ${entry.error}`);
    }
  },
};
