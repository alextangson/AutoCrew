/**
 * AutoCrew Init — Initialize the ~/.autocrew/ data directory.
 *
 * Creates the directory structure and empty creator-profile.json.
 * Safe to run multiple times (idempotent).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { initProfile } from "../modules/profile/creator-profile.js";

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

const SUBDIRS = [
  "topics",
  "contents",
  "learnings/edits",
  "assets/raw",
  "sensitive-words",
  "covers/templates",
  "competitors",
  "pipelines",
  "memory",
];

export interface InitResult {
  ok: boolean;
  dataDir: string;
  created: string[];
  alreadyExisted: boolean;
}

export async function executeInit(options?: { dataDir?: string }): Promise<InitResult> {
  const dataDir = getDataDir(options?.dataDir);
  const created: string[] = [];

  // Check if already initialized
  let alreadyExisted = false;
  try {
    await fs.access(dataDir);
    alreadyExisted = true;
  } catch {
    // Will create
  }

  // Create all subdirectories
  for (const sub of SUBDIRS) {
    const dir = path.join(dataDir, sub);
    try {
      await fs.mkdir(dir, { recursive: true });
      created.push(sub);
    } catch {
      // Already exists — fine
    }
  }

  // Initialize creator-profile.json (no-op if exists)
  await initProfile(dataDir);

  // Create empty STYLE.md if not exists
  const stylePath = path.join(dataDir, "STYLE.md");
  try {
    await fs.access(stylePath);
  } catch {
    await fs.writeFile(
      stylePath,
      "# Writing Style\n\n> 尚未校准。运行「风格校准」来设置你的写作风格。\n",
      "utf-8",
    );
    created.push("STYLE.md");
  }

  // Create empty custom sensitive words file if not exists
  const customWordsPath = path.join(dataDir, "sensitive-words", "custom.txt");
  try {
    await fs.access(customWordsPath);
  } catch {
    await fs.writeFile(customWordsPath, "# 自定义敏感词（每行一个）\n", "utf-8");
    created.push("sensitive-words/custom.txt");
  }

  return { ok: true, dataDir, created, alreadyExisted };
}
