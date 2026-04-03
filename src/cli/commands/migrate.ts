import type { CommandDef } from "./index.js";
import { migrateLegacyData } from "../../modules/migrate/legacy-migrate.js";

export const cmd: CommandDef = {
  name: "migrate",
  description: "Migrate legacy data to the new pipeline format",
  usage: "autocrew migrate",
  action: async (_args, _runner, ctx) => {
    console.log("Migrating legacy data...");
    const result = await migrateLegacyData(ctx.dataDir);

    console.log(`  Topics migrated:   ${result.topicsMigrated}`);
    console.log(`  Contents migrated: ${result.contentsMigrated}`);

    if (result.errors.length > 0) {
      console.log(`\n  Errors (${result.errors.length}):`);
      for (const err of result.errors) {
        console.log(`    - ${err}`);
      }
    } else {
      console.log("\n  Migration complete — no errors.");
    }
  },
};
