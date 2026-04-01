import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

export type MemorySignalType =
  | "approval"
  | "rejection"
  | "edit"
  | "performance"
  | "general";

export interface DistillMemoryOptions {
  signalType: MemorySignalType;
  feedback?: string;
  originalText?: string;
  modifiedText?: string;
  contentTitle?: string;
  platform?: string;
  dataDir?: string;
}

export interface DistillMemoryResult {
  ok: boolean;
  section: string;
  learning: string;
  memoryPath: string;
  archivePath: string;
}

const MEMORY_TEMPLATE = `# AutoCrew Memory

## Brand Context

## Writing Preferences

## Content Edit Preferences

## Performance Insights
`;

function resolveDataDir(customDir?: string): string {
  if (customDir) return customDir;
  return path.join(os.homedir(), ".autocrew");
}

async function ensureMemoryFiles(dataDir?: string) {
  const root = resolveDataDir(dataDir);
  const memoryPath = path.join(root, "MEMORY.md");
  const archiveDir = path.join(root, "memory");
  await fs.mkdir(archiveDir, { recursive: true });
  try {
    await fs.access(memoryPath);
  } catch {
    await fs.writeFile(memoryPath, MEMORY_TEMPLATE, "utf-8");
  }
  return { root, memoryPath, archiveDir };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function inferFromFeedback(feedback: string): { section: string; learning: string } | null {
  const normalized = feedback.trim();
  if (!normalized) return null;

  if (/口语|人话|自然|书面腔|太正式/.test(normalized)) {
    return {
      section: "Writing Preferences",
      learning: "写作偏好更口语、更自然，减少书面腔和过度正式表达",
    };
  }
  if (/短一点|精简|短句|更直接|删掉废话/.test(normalized)) {
    return {
      section: "Content Edit Preferences",
      learning: "用户偏好更短句、更直接的表达，减少铺陈和废话",
    };
  }
  if (/emoji|表情/.test(normalized)) {
    return {
      section: "Writing Preferences",
      learning: "用户对 emoji 使用有明确偏好，后续需要按平台控制频率和位置",
    };
  }
  if (/标题|hook|开头|前3秒/.test(normalized)) {
    return {
      section: "Content Edit Preferences",
      learning: "用户对标题和开头钩子更敏感，后续应优先优化停留感和首屏表达",
    };
  }
  if (/爆|点赞|收藏|转化|播放|点击率/.test(normalized)) {
    return {
      section: "Performance Insights",
      learning: normalized,
    };
  }

  return {
    section: "Content Edit Preferences",
    learning: normalized,
  };
}

function inferFromEdit(originalText: string, modifiedText: string): { section: string; learning: string } {
  const originalLength = originalText.length;
  const modifiedLength = modifiedText.length;
  if (modifiedLength < originalLength * 0.8) {
    return {
      section: "Content Edit Preferences",
      learning: "用户修改时明显压缩篇幅，偏好更短、更狠、更直接的表达",
    };
  }

  if (/口语|你|我|问题来了|说白了/.test(modifiedText) && !/口语|你|我|问题来了|说白了/.test(originalText)) {
    return {
      section: "Writing Preferences",
      learning: "用户会主动把稿子改得更口语、更像当面说话",
    };
  }

  return {
    section: "Content Edit Preferences",
    learning: "用户对草稿做了实质修改，后续应优先参考最近一次改稿方向",
  };
}

function buildLearning(options: DistillMemoryOptions): { section: string; learning: string } {
  if (options.signalType === "edit" && options.originalText && options.modifiedText) {
    return inferFromEdit(options.originalText, options.modifiedText);
  }

  if (options.feedback) {
    const inferred = inferFromFeedback(options.feedback);
    if (inferred) return inferred;
  }

  switch (options.signalType) {
    case "approval":
      return {
        section: "Performance Insights",
        learning: `用户确认了${options.platform ? `${options.platform} ` : ""}方向，当前表达方式可继续复用`,
      };
    case "rejection":
      return {
        section: "Content Edit Preferences",
        learning: `用户拒绝了当前${options.platform ? `${options.platform} ` : ""}稿件方向，后续需要先重做角度而不是只润色句子`,
      };
    case "performance":
      return {
        section: "Performance Insights",
        learning: options.feedback || "记录了一条新的内容表现反馈",
      };
    default:
      return {
        section: "Content Edit Preferences",
        learning: options.feedback || "记录了一条新的用户反馈",
      };
  }
}

function appendLearningToSection(memoryContent: string, section: string, learning: string): string {
  const marker = `## ${section}`;
  const entry = `- [${today()}] ${learning}`;
  if (!memoryContent.includes(marker)) {
    return `${memoryContent.trim()}\n\n${marker}\n\n${entry}\n`;
  }

  const existingEntryPattern = new RegExp(`^- \\[\\d{4}-\\d{2}-\\d{2}\\] ${learning.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
  if (existingEntryPattern.test(memoryContent)) {
    return memoryContent;
  }

  const start = memoryContent.indexOf(marker) + marker.length;
  const nextSectionIndex = memoryContent.indexOf("\n## ", start);
  if (nextSectionIndex === -1) {
    return `${memoryContent.trimEnd()}\n\n${entry}\n`;
  }

  return `${memoryContent.slice(0, nextSectionIndex).trimEnd()}\n\n${entry}\n${memoryContent.slice(nextSectionIndex)}`;
}

export async function distillMemory(options: DistillMemoryOptions): Promise<DistillMemoryResult> {
  const { memoryPath, archiveDir } = await ensureMemoryFiles(options.dataDir);
  const raw = await fs.readFile(memoryPath, "utf-8");
  const { section, learning } = buildLearning(options);
  const nextMemory = appendLearningToSection(raw, section, learning);
  await fs.writeFile(memoryPath, nextMemory, "utf-8");

  const archivePath = path.join(archiveDir, `${today()}.jsonl`);
  const archiveEntry = {
    timestamp: new Date().toISOString(),
    signalType: options.signalType,
    feedback: options.feedback || null,
    contentTitle: options.contentTitle || null,
    platform: options.platform || null,
    section,
    learning,
  };
  await fs.appendFile(archivePath, `${JSON.stringify(archiveEntry, null, 0)}\n`, "utf-8");

  return {
    ok: true,
    section,
    learning,
    memoryPath,
    archivePath,
  };
}
