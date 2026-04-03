import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "contents",
  description: "List content items",
  usage: "autocrew contents",
  action: async (_args, runner) => {
    const result = await runner.execute("autocrew_content", { action: "list" });
    const items = (result.items || []) as any[];
    if (items.length === 0) {
      console.log("No content yet. Use 'autocrew_content' tool to save drafts.");
      return;
    }
    for (const c of items) {
      console.log(`[${c.id}] ${c.title} — ${c.status} (${c.platform || "general"})`);
    }
  },
};
