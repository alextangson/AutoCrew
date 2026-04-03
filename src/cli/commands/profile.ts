import type { CommandDef } from "./index.js";
import { loadProfile, detectMissingInfo } from "../../modules/profile/creator-profile.js";

export const cmd: CommandDef = {
  name: "profile",
  description: "Show creator profile",
  usage: "autocrew profile",
  action: async (_args, _runner, ctx) => {
    const profile = await loadProfile(ctx.dataDir);
    if (!profile) {
      console.log("No creator profile yet. Run 'autocrew init' first.");
      return;
    }
    console.log(`Industry: ${profile.industry || "(not set)"}`);
    console.log(`Platforms: ${profile.platforms.length > 0 ? profile.platforms.join(", ") : "(not set)"}`);
    console.log(`Style calibrated: ${profile.styleCalibrated ? "yes" : "no"}`);
    if (profile.audiencePersona) {
      console.log(`Audience: ${profile.audiencePersona.name} (${profile.audiencePersona.age || "?"}, ${profile.audiencePersona.job || "?"})`);
    } else {
      console.log(`Audience: (not set)`);
    }
    console.log(`Writing rules: ${profile.writingRules.length}`);
    console.log(`Competitors: ${profile.competitorAccounts.length}`);
    console.log(`Performance entries: ${profile.performanceHistory.length}`);

    const missing = detectMissingInfo(profile);
    if (missing.length > 0) {
      console.log(`\nMissing: ${missing.join(", ")}`);
    }
  },
};
