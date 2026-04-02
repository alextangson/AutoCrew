import path from "node:path";
import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { getContent } from "../storage/local-store.js";
import { distillMemory } from "../modules/memory/distill.js";

export const memorySchema = Type.Object({
  action: Type.Unsafe<"capture_feedback" | "get_memory">({
    type: "string",
    enum: ["capture_feedback", "get_memory"],
    description: "Capture a new feedback signal into memory, or read the current MEMORY.md file.",
  }),
  signal_type: Type.Optional(
    Type.Unsafe<"approval" | "rejection" | "edit" | "performance" | "general">({
      type: "string",
      enum: ["approval", "rejection", "edit", "performance", "general"],
      description: "Feedback signal type for capture_feedback.",
    }),
  ),
  content_id: Type.Optional(Type.String({ description: "Optional AutoCrew content id." })),
  feedback: Type.Optional(Type.String({ description: "Freeform user feedback or performance note." })),
  original_text: Type.Optional(Type.String({ description: "Original text before user edit." })),
  modified_text: Type.Optional(Type.String({ description: "User-edited or final text." })),
  platform: Type.Optional(Type.String({ description: "Optional platform label." })),
});

function resolveDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

export async function executeMemory(params: Record<string, unknown>) {
  const action = params.action as string;
  const dataDir = (params._dataDir as string) || undefined;

  if (action === "get_memory") {
    const memoryPath = path.join(resolveDataDir(dataDir), "MEMORY.md");
    try {
      const content = await fs.readFile(memoryPath, "utf-8");
      return { ok: true, memoryPath, content };
    } catch {
      return { ok: true, memoryPath, content: "", note: "MEMORY.md 尚未创建。使用 capture_feedback 记录反馈后会自动生成。" };
    }
  }

  if (action !== "capture_feedback") {
    return { ok: false, error: `Unknown action: ${action}` };
  }

  const signalType = (params.signal_type as any) || "general";
  let contentTitle: string | undefined;
  let originalText = (params.original_text as string) || undefined;
  let modifiedText = (params.modified_text as string) || undefined;
  let platform = (params.platform as string) || undefined;

  const contentId = params.content_id as string | undefined;
  if (contentId) {
    const content = await getContent(contentId, dataDir);
    if (content) {
      contentTitle = content.title;
      platform = platform || content.platform;
      originalText = originalText || content.body;
    }
  }

  return distillMemory({
    signalType,
    feedback: (params.feedback as string) || undefined,
    originalText,
    modifiedText,
    contentTitle,
    platform,
    dataDir,
  });
}
