/**
 * Install Chrome native messaging host manifest and launch wrapper.
 * Hand-run script, not part of test suite. Idempotent.
 *
 * Usage: npx tsx scripts/install-native-host.mts <extension-id>
 * Args: extension ID (32 lowercase letters a-p, hex format validation)
 *
 * Creates:
 * - ~/.autocrew/bridge/launch.sh: bash wrapper → npx tsx src/bridge/native-host.ts
 * - ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.autocrew.bridge.json
 *   (manifest registering launch.sh and allowed extension origin)
 *
 * Prints next-step verification instructions in Chinese.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const extensionId = process.argv[2];

if (!extensionId) {
  console.error("Usage: npx tsx scripts/install-native-host.mts <extension-id>");
  process.exit(1);
}

// Validate extension ID format (32 hex chars a-p = Chrome extension ID)
if (!/^[a-p]{32}$/.test(extensionId)) {
  console.error(
    `Invalid extension ID format: "${extensionId}"\n` +
      "Expected: 32 lowercase letters a-p (Chrome extension ID hex format)",
  );
  process.exit(1);
}

// Resolve repo root at install time (one level up from scripts/)
const repoRoot = path.resolve(import.meta.dirname, "..");
const launchShPath = path.join(
  process.env.HOME || "/Users/macmini",
  ".autocrew/bridge/launch.sh",
);
const manifestDir = path.join(
  process.env.HOME || "/Users/macmini",
  "Library/Application Support/Google/Chrome/NativeMessagingHosts",
);
const manifestPath = path.join(manifestDir, "com.autocrew.bridge.json");

// 1. Create ~/.autocrew/bridge/ directory if missing
const launchDir = path.dirname(launchShPath);
fs.mkdirSync(launchDir, { recursive: true });

// 2. Write launch.sh
const launchScript = `#!/bin/bash
exec npx tsx ${path.join(repoRoot, "src/bridge/native-host.ts")}
`;
fs.writeFileSync(launchShPath, launchScript);
execSync(`chmod 755 ${launchShPath}`);

// 3. Write manifest JSON
fs.mkdirSync(manifestDir, { recursive: true });
const manifest = {
  name: "com.autocrew.bridge",
  description: "AutoCrew bridge",
  path: launchShPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log("✓ Native host installed successfully\n");
console.log("Next steps:");
console.log("1. Open chrome://extensions (enable Developer mode)");
console.log("2. Load unpacked: select extension/ directory from this repo");
console.log("3. Copy the extension ID (should match your argument)");
console.log("4. Open creator.douyin.com and click the AutoCrew extension button");
console.log("5. Check 'autocrew_flywheel action=report' in logs to verify import\n");
console.log("Files written:");
console.log(`  ${launchShPath}`);
console.log(`  ${manifestPath}\n`);
console.log("Extension ID: " + extensionId);
