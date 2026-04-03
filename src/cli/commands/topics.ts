import type { CommandDef } from "./index.js";

export const cmd: CommandDef = {
  name: "topics",
  description: "List saved topics",
  usage: "autocrew topics",
  action: async (_args, runner) => {
    const result = await runner.execute("autocrew_topic", { action: "list" });
    const topics = (result.topics || []) as any[];
    if (topics.length === 0) {
      console.log("No topics yet. Use 'autocrew research' to create some.");
      return;
    }
    for (const t of topics) {
      console.log(`[${t.id}] ${t.title} (${t.platform || "general"}) — score: ${t.viralScore ?? "?"}`);
    }
  },
};
