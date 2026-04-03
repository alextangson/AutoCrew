/**
 * AutoCrew Init — Initialize the ~/.autocrew/ data directory.
 *
 * Creates the directory structure and empty creator-profile.json.
 * Safe to run multiple times (idempotent).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { initProfile, detectMissingInfo } from "../modules/profile/creator-profile.js";
import { initPipeline } from "../storage/pipeline-store.js";

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
  next_step?: {
    action: string;
    message: string;
    steps: string[];
  };
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

  // Initialize pipeline directory structure (idempotent)
  await initPipeline(dataDir);

  // Initialize creator-profile.json (no-op if exists)
  const profile = await initProfile(dataDir);

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

  // Check profile completeness to guide next steps
  const missing = detectMissingInfo(profile);

  let next_step: InitResult["next_step"];

  if (missing.length > 0) {
    const needsOnboarding = missing.some((m) => m !== "style");
    const needsCalibration = missing.includes("style") || !profile.styleCalibrated;

    if (needsOnboarding) {
      next_step = {
        action: "onboarding",
        message: "⚠️ 创作者档案不完整，请先完成初始设置。",
        steps: [
          "1. 询问用户：你的行业/领域是什么？",
          "2. 询问用户：你主要在哪些平台发内容？（小红书/抖音/公众号/视频号）",
          "3. 询问用户：你的目标受众是谁？",
          "4. 将信息保存到 creator-profile.json",
          ...(needsCalibration
            ? [
                "5. 进行风格校准：通过 A/B 选择题确定写作风格偏好",
                "6. 生成 STYLE.md 并更新 creator-profile.json 的 styleCalibrated 为 true",
              ]
            : []),
        ],
      };
    } else if (needsCalibration) {
      next_step = {
        action: "style_calibration",
        message: "✨ 初始化完成！接下来进行风格校准，让写出来的内容更贴合你的调性。",
        steps: [
          "1. 询问用户的风格偏好（正式vs口语、专业vs大白话、长文vs短文、情感vs干货）",
          "2. 根据回答生成 ~/.autocrew/STYLE.md",
          "3. 更新 creator-profile.json: styleCalibrated = true",
        ],
      };
    }
  }

  return { ok: true, dataDir, created, alreadyExisted, next_step };
}
