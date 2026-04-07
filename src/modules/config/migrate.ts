/**
 * Migration — moves legacy omniConfig/videoCrawler fields from
 * creator-profile.json into the new services.json format.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { saveServiceConfig, type ServiceConfig } from "./service-config.js";

const PROFILE_FILE = "creator-profile.json";
const SERVICE_FILE = "services.json";

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

export async function migrateProfileToServices(
  dataDir?: string,
): Promise<{ migrated: boolean; reason?: string }> {
  const dir = getDataDir(dataDir);
  const servicesPath = path.join(dir, SERVICE_FILE);
  const profilePath = path.join(dir, PROFILE_FILE);

  // 1. Bail if services.json already exists
  try {
    await fs.access(servicesPath);
    return { migrated: false, reason: "services.json already exists" };
  } catch {
    // File doesn't exist — continue
  }

  // 2. Load profile as raw JSON
  let raw: Record<string, unknown>;
  try {
    const content = await fs.readFile(profilePath, "utf-8");
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { migrated: false, reason: "nothing to migrate" };
  }

  // 3. Check if there's anything to migrate
  if (!raw.omniConfig && !raw.videoCrawler) {
    return { migrated: false, reason: "nothing to migrate" };
  }

  // 4. Build ServiceConfig from old fields
  const now = new Date().toISOString();
  const svcConfig: ServiceConfig = {
    configuredAt: now,
    updatedAt: now,
  };

  if (raw.omniConfig) {
    const old = raw.omniConfig as Record<string, string>;
    svcConfig.omni = {
      provider: "xiaomi",
      baseUrl: old.baseUrl,
      model: old.model,
      apiKey: old.apiKey,
    };
  }

  if (raw.videoCrawler) {
    const old = raw.videoCrawler as Record<string, string>;
    svcConfig.videoCrawler = {
      type: old.type as "mediacrawl" | "playwright" | "manual",
      command: old.command,
    };
  }

  // 5. Save new services.json
  await saveServiceConfig(svcConfig, dataDir);

  // 6. Clean up profile
  delete raw.omniConfig;
  delete raw.videoCrawler;
  raw.updatedAt = now;
  await fs.writeFile(profilePath, JSON.stringify(raw, null, 2), "utf-8");

  // 7. Done
  return { migrated: true };
}
