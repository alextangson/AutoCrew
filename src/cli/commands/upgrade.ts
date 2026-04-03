import type { CommandDef } from "./index.js";
import { getOption } from "./index.js";
import { saveProKey, getProStatus } from "../../modules/pro/gate.js";
import { verifyKey } from "../../modules/pro/api-client.js";

export const cmd: CommandDef = {
  name: "upgrade",
  description: "Activate or verify AutoCrew Pro",
  usage: "autocrew upgrade [--key <key>]",
  action: async (args, _runner, ctx) => {
    const key = getOption(args, "--key");

    if (key) {
      await saveProKey(key, ctx.dataDir);
      console.log("Pro API key saved. Verifying...");
      const result = await verifyKey({ dataDir: ctx.dataDir });
      if (result.ok && result.data?.valid) {
        console.log(`Pro activated! Plan: ${result.data.plan}`);
        if (result.data.expiresAt) {
          console.log(`  Expires: ${result.data.expiresAt}`);
        }
        if (result.data.usage) {
          console.log(`  Usage: ${result.data.usage.used}/${result.data.usage.used + result.data.usage.remaining} ${result.data.usage.unit}`);
        }
      } else {
        console.error(`Verification failed: ${result.error || "invalid key"}`);
        console.log("Key saved locally but could not be verified. Check your network or key.");
      }
    } else {
      const status = await getProStatus(ctx.dataDir);
      if (status.isPro) {
        console.log("AutoCrew Pro is active.");
        const result = await verifyKey({ dataDir: ctx.dataDir });
        if (result.ok && result.data) {
          console.log(`  Plan: ${result.data.plan}`);
          if (result.data.usage) {
            console.log(`  Usage: ${result.data.usage.used}/${result.data.usage.used + result.data.usage.remaining} ${result.data.usage.unit}`);
          }
        }
      } else {
        console.log("AutoCrew Free version.");
        console.log("\nPro features: deep crawling, competitor monitoring, analytics, TTS, digital human.");
        console.log("Get your Pro key at: https://autocrew.dev/activate");
        console.log("\nActivate: autocrew upgrade --key <your-key>");
      }
    }
  },
};
