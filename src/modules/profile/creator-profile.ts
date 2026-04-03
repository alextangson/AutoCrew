/**
 * Creator Profile — Structured creator persona stored at ~/.autocrew/creator-profile.json
 *
 * This is the core identity file that drives personalized writing, topic scoring,
 * and style calibration. It's initialized during onboarding (from host MEMORY or
 * by asking the user) and continuously enriched by the Learnings system.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface WritingRule {
  rule: string;
  /** "auto_distilled" = extracted from user edits, "user_explicit" = user stated directly */
  source: "auto_distilled" | "user_explicit";
  /** 0-1, higher = more confident */
  confidence: number;
  createdAt: string;
}

export interface AudiencePersona {
  name: string;
  age?: string;
  job?: string;
  painPoints: string[];
  scrollStopTriggers?: string[];
}

export interface CompetitorAccount {
  platform: string;
  profileUrl: string;
  name: string;
  addedAt: string;
}

export interface PerformanceEntry {
  contentId: string;
  platform: string;
  metrics: Record<string, number>;
  recordedAt: string;
}

export interface CreatorPersona {
  /** Creator personality type: thought_leader, storyteller, analyst, curator, entertainer */
  type: string;
  /** One-line unique angle — what makes this creator different */
  uniqueAngle: string;
  /** Content goals: growth, monetization, branding, community */
  contentGoals: string[];
  /** Core expertise areas */
  expertise: string[];
  /** Why audience follows this creator (not competitors) */
  audienceResonance: string;
  /** Creator's blind spots or growth areas */
  growthAreas: string[];
}

export interface CreatorProfile {
  /** User's content industry/niche */
  industry: string;
  /** Active platforms */
  platforms: string[];
  /** Target audience persona */
  audiencePersona: AudiencePersona | null;
  /** Creator personality profile (from calibration) */
  creatorPersona: CreatorPersona | null;
  /** Auto-distilled + user-explicit writing rules */
  writingRules: WritingRule[];
  /** Style boundaries */
  styleBoundaries: { never: string[]; always: string[] };
  /** Competitor accounts (Pro) */
  competitorAccounts: CompetitorAccount[];
  /** Historical performance data points */
  performanceHistory: PerformanceEntry[];
  /** Whether style calibration has been completed */
  styleCalibrated: boolean;
  /** Profile creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

const PROFILE_FILE = "creator-profile.json";

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

function emptyProfile(): CreatorProfile {
  const now = new Date().toISOString();
  return {
    industry: "",
    platforms: [],
    audiencePersona: null,
    creatorPersona: null,
    writingRules: [],
    styleBoundaries: { never: [], always: [] },
    competitorAccounts: [],
    performanceHistory: [],
    styleCalibrated: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Check if creator-profile.json exists.
 */
export async function profileExists(dataDir?: string): Promise<boolean> {
  const filePath = path.join(getDataDir(dataDir), PROFILE_FILE);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the creator profile. Returns null if it doesn't exist.
 */
export async function loadProfile(dataDir?: string): Promise<CreatorProfile | null> {
  const filePath = path.join(getDataDir(dataDir), PROFILE_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as CreatorProfile;
  } catch {
    return null;
  }
}

/**
 * Save the full creator profile (overwrite).
 */
export async function saveProfile(profile: CreatorProfile, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  profile.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, PROFILE_FILE), JSON.stringify(profile, null, 2), "utf-8");
}

/**
 * Initialize a new empty profile. No-op if one already exists.
 * Returns the profile (existing or newly created).
 */
export async function initProfile(dataDir?: string): Promise<CreatorProfile> {
  const existing = await loadProfile(dataDir);
  if (existing) return existing;
  const profile = emptyProfile();
  await saveProfile(profile, dataDir);
  return profile;
}

/**
 * Partially update the profile (merge fields).
 */
export async function updateProfile(
  updates: Partial<Omit<CreatorProfile, "createdAt" | "updatedAt">>,
  dataDir?: string,
): Promise<CreatorProfile> {
  let profile = await loadProfile(dataDir);
  if (!profile) profile = emptyProfile();

  const merged: CreatorProfile = {
    ...profile,
    ...updates,
    // Arrays: replace entirely if provided, keep existing otherwise
    writingRules: updates.writingRules ?? profile.writingRules,
    competitorAccounts: updates.competitorAccounts ?? profile.competitorAccounts,
    performanceHistory: updates.performanceHistory ?? profile.performanceHistory,
    // Preserve immutable fields
    createdAt: profile.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await saveProfile(merged, dataDir);
  return merged;
}

/**
 * Add a writing rule (deduplicates by rule text).
 */
export async function addWritingRule(rule: Omit<WritingRule, "createdAt">, dataDir?: string): Promise<CreatorProfile> {
  const profile = (await loadProfile(dataDir)) || emptyProfile();
  const exists = profile.writingRules.some((r) => r.rule === rule.rule);
  if (!exists) {
    profile.writingRules.push({ ...rule, createdAt: new Date().toISOString() });
  }
  await saveProfile(profile, dataDir);
  return profile;
}

/**
 * Add a competitor account (deduplicates by profileUrl).
 */
export async function addCompetitor(account: Omit<CompetitorAccount, "addedAt">, dataDir?: string): Promise<CreatorProfile> {
  const profile = (await loadProfile(dataDir)) || emptyProfile();
  const exists = profile.competitorAccounts.some((c) => c.profileUrl === account.profileUrl);
  if (!exists) {
    profile.competitorAccounts.push({ ...account, addedAt: new Date().toISOString() });
  }
  await saveProfile(profile, dataDir);
  return profile;
}

/**
 * Record a performance data point.
 */
export async function addPerformanceEntry(entry: Omit<PerformanceEntry, "recordedAt">, dataDir?: string): Promise<void> {
  const profile = (await loadProfile(dataDir)) || emptyProfile();
  profile.performanceHistory.push({ ...entry, recordedAt: new Date().toISOString() });
  // Keep last 100 entries
  if (profile.performanceHistory.length > 100) {
    profile.performanceHistory = profile.performanceHistory.slice(-100);
  }
  await saveProfile(profile, dataDir);
}

/**
 * Detect what information is missing from the profile.
 * Used by the onboarding skill to decide what to ask.
 */
export function detectMissingInfo(profile: CreatorProfile): string[] {
  const missing: string[] = [];
  if (!profile.industry) missing.push("industry");
  if (profile.platforms.length === 0) missing.push("platforms");
  if (!profile.audiencePersona) missing.push("audience");
  if (!profile.styleCalibrated) missing.push("style");
  return missing;
}
