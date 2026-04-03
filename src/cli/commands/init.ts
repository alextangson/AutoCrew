import type { CommandDef } from "./index.js";
import { loadProfile, detectMissingInfo } from "../../modules/profile/creator-profile.js";

export const cmd: CommandDef = {
  name: "init",
  description: "Initialize ~/.autocrew/ data directory and creator profile",
  usage: "autocrew init",
  action: async (_args, runner, ctx) => {
    const result = await runner.execute("autocrew_init", {});
    if (result.alreadyExisted) {
      console.log(`AutoCrew already initialized at ${result.dataDir}`);
    } else {
      console.log(`AutoCrew initialized at ${result.dataDir}`);
    }
    console.log(`  Created: ${(result.created as any[])?.length ?? 0} items`);

    const profile = await loadProfile(ctx.dataDir);
    if (profile) {
      const missing = detectMissingInfo(profile);
      if (missing.length > 0) {
        console.log(`\n  Profile incomplete — missing: ${missing.join(", ")}`);
        console.log(`  Start a conversation with your agent to complete onboarding.`);
      } else {
        console.log(`\n  Profile complete. Ready to go!`);
      }
    }
  },
};
