/**
 * Pro Gate — Feature gating for AutoCrew Pro.
 *
 * Checks whether the user has a valid Pro API key stored in ~/.autocrew/.pro
 * and provides helpers to guard Pro-only tool actions.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface ProStatus {
  isPro: boolean;
  apiKey: string | null;
  verified: boolean | null;
  expiresAt: string | null;
}

const PRO_FILE = ".pro";

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

export async function readProKey(dataDir?: string): Promise<string | null> {
  const filePath = path.join(getDataDir(dataDir), PRO_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const key = raw.trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export async function saveProKey(apiKey: string, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, PRO_FILE), apiKey.trim() + "\n", "utf-8");
}

export async function removeProKey(dataDir?: string): Promise<void> {
  try {
    await fs.unlink(path.join(getDataDir(dataDir), PRO_FILE));
  } catch { /* already gone */ }
}

export async function getProStatus(dataDir?: string): Promise<ProStatus> {
  const apiKey = await readProKey(dataDir);
  return { isPro: apiKey !== null, apiKey, verified: null, expiresAt: null };
}

/**
 * Guard a Pro-only feature. Returns null if Pro, or an error object if Free.
 *
 *   const gate = await requirePro("对标账号监控", dataDir);
 *   if (gate) return gate;
 */
export async function requirePro(
  featureName: string,
  dataDir?: string,
): Promise<{ ok: false; error: string; upgradeHint: string; freeAlternative?: string } | null> {
  const status = await getProStatus(dataDir);
  if (status.isPro) return null;
  return {
    ok: false,
    error: `「${featureName}」是 Pro 版功能。`,
    upgradeHint: "运行 autocrew upgrade 了解 Pro 版详情。",
  };
}

export function proGateResponse(
  featureName: string,
  freeAlternative: string,
): { ok: false; error: string; upgradeHint: string; freeAlternative: string } {
  return {
    ok: false,
    error: `「${featureName}」是 Pro 版功能。`,
    upgradeHint: "运行 autocrew upgrade 了解 Pro 版详情。",
    freeAlternative,
  };
}

export const PRO_FEATURES = [
  "competitor-monitor",
  "extract-video-script",
  "video-analysis",
  "analytics-report",
  "research-crawl",
  "research-trending",
  "cover-multi-ratio",
  "tts-synthesize",
  "tts-clone",
  "digital-human",
  "publish-wechat-mp",
  "publish-wechat-video",
  "publish-bilibili",
] as const;

export type ProFeature = (typeof PRO_FEATURES)[number];

export function isProFeature(featureId: string): boolean {
  return (PRO_FEATURES as readonly string[]).includes(featureId);
}
