import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "events",
  description: "Show recent event history",
  usage: "autocrew events",
  action: async (_args, _runner, _ctx, eventBus) => {
    const history = eventBus.getHistory(20);
    if (history.length === 0) {
      console.log("No events yet.");
      return;
    }
    for (const e of history) {
      console.log(`  ${e.type} — ${JSON.stringify(e.data)} (${e.timestamp})`);
    }
  },
};
