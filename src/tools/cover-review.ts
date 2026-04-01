/**
 * Cover Review Tool — generate, review, and approve cover images.
 *
 * Actions:
 * - create_candidates: generate 3 style variants (A/B/C) as 3:4 images
 * - get: retrieve existing cover review for a content
 * - approve: approve a selected variant
 * - generate_ratios: [Pro] generate 16:9 + 4:3 from approved cover
 */
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  getContent,
  getCoverReview,
  saveCoverReview,
  approveCoverVariant,
  type CoverReview,
  type CoverVariant,
} from "../storage/local-store.js";
import { buildCoverPrompts, type CoverPromptSet } from "../modules/cover/prompt-builder.js";
import { generateImage, listReferencePhotos, type GeminiModel } from "../adapters/image/gemini.js";
import { generateMultiRatio } from "../modules/cover/ratio-adapter.js";

type CoverLabel = "a" | "b" | "c";

export const coverReviewSchema = Type.Object({
  action: Type.Unsafe<"create_candidates" | "get" | "approve" | "generate_ratios">({
    type: "string",
    enum: ["create_candidates", "get", "approve", "generate_ratios"],
    description:
      "Cover action: create_candidates (generate 3 covers), get (view review), approve (pick one), generate_ratios (Pro: 16:9 + 4:3).",
  }),
  content_id: Type.String({ description: "AutoCrew content id." }),
  label: Type.Optional(
    Type.Unsafe<CoverLabel>({
      type: "string",
      enum: ["a", "b", "c"],
      description: "Which variant to approve (for approve action).",
    }),
  ),
  custom_title: Type.Optional(
    Type.String({ description: "Override the auto-extracted cover title (2-8 Chinese chars)." }),
  ),
  _geminiApiKey: Type.Optional(Type.String()),
  _geminiModel: Type.Optional(Type.String()),
  _dataDir: Type.Optional(Type.String()),
});

function getDataDir(params: Record<string, unknown>): string {
  if (params._dataDir) return params._dataDir as string;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

function getGeminiApiKey(params: Record<string, unknown>): string | null {
  return (params._geminiApiKey as string) || process.env.GEMINI_API_KEY || null;
}

function getGeminiModel(params: Record<string, unknown>): GeminiModel {
  const m = params._geminiModel as string;
  if (m === "imagen-4" || m === "gemini-native") return m;
  return "auto";
}

export async function executeCoverReview(params: Record<string, unknown>) {
  const action = params.action as string;
  const contentId = params.content_id as string;
  const dataDir = getDataDir(params);

  if (!contentId) return { ok: false, error: "content_id is required" };

  // --- GET ---
  if (action === "get") {
    const review = await getCoverReview(contentId, dataDir);
    if (!review) return { ok: false, error: `No cover review found for ${contentId}` };
    return { ok: true, review };
  }

  // --- APPROVE ---
  if (action === "approve") {
    const label = params.label as CoverLabel;
    if (!label) return { ok: false, error: "label (a/b/c) is required for approve action" };

    const result = await approveCoverVariant(contentId, label, dataDir);
    if (!result) return { ok: false, error: `Failed to approve variant ${label} for ${contentId}` };
    return { ok: true, review: result };
  }

  // --- CREATE CANDIDATES ---
  if (action === "create_candidates") {
    const apiKey = getGeminiApiKey(params);
    if (!apiKey) {
      return {
        ok: false,
        error: "Gemini API key required for cover generation.",
        hint: "免费获取：https://aistudio.google.com/apikey — 在 OpenClaw 插件设置中填入 gemini_api_key",
      };
    }

    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, error: `Content ${contentId} not found` };

    const model = getGeminiModel(params);
    const referencePhotos = await listReferencePhotos(dataDir);

    // Build 3 prompt sets
    const promptSets = buildCoverPrompts({
      title: content.title,
      body: content.body,
      platform: content.platform,
      hasReferencePhotos: referencePhotos.length > 0,
      customTitle: params.custom_title as string | undefined,
    });

    // Generate 3 images
    const assetsDir = path.join(dataDir, "contents", contentId, "assets", "covers");
    const variants: CoverVariant[] = [];
    const errors: string[] = [];

    for (const ps of promptSets) {
      const outputPath = path.join(assetsDir, `cover-${ps.label.toLowerCase()}`);
      const result = await generateImage({
        prompt: ps.imagePrompt,
        aspectRatio: "3:4",
        model,
        apiKey,
        referenceImagePaths: referencePhotos.length > 0 ? referencePhotos : undefined,
        outputPath,
      });

      if (result.ok) {
        variants.push({
          label: ps.label.toLowerCase() as CoverLabel,
          imagePrompt: ps.imagePrompt,
          style: ps.style,
          titleText: ps.titleText,
          imagePaths: { "3:4": result.imagePath },
          model: result.model,
          hasPersonalIP: referencePhotos.length > 0,
          layoutHint: ps.layoutHint,
          designReason: `${ps.style} 风格 — ${ps.layoutHint.slice(0, 60)}`,
        });
      } else {
        errors.push(`${ps.label}: ${result.error}`);
      }
    }

    if (variants.length === 0) {
      return { ok: false, error: "All 3 cover generations failed", details: errors };
    }

    // Save cover review
    const review: CoverReview = {
      platform: content.platform || "xhs",
      status: "review_pending",
      variants,
      createdAt: new Date().toISOString(),
    };

    const saved = await saveCoverReview(contentId, review, dataDir);
    if (!saved) return { ok: false, error: "Failed to save cover review" };

    return {
      ok: true,
      review,
      generated: variants.length,
      failed: errors.length,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // --- GENERATE RATIOS (Pro) ---
  if (action === "generate_ratios") {
    const apiKey = getGeminiApiKey(params);
    if (!apiKey) {
      return { ok: false, error: "Gemini API key required." };
    }

    const review = await getCoverReview(contentId, dataDir);
    if (!review) return { ok: false, error: `No cover review found for ${contentId}` };
    if (!review.approvedLabel) return { ok: false, error: "No variant approved yet. Run approve first." };

    const approved = review.variants.find((v) => v.label === review.approvedLabel);
    if (!approved?.imagePrompt) return { ok: false, error: "Approved variant has no prompt" };

    const model = getGeminiModel(params);
    const referencePhotos = approved.hasPersonalIP ? await listReferencePhotos(dataDir) : undefined;
    const assetsDir = path.join(dataDir, "contents", contentId, "assets", "covers");

    const result = await generateMultiRatio({
      originalPrompt: approved.imagePrompt,
      apiKey,
      model,
      referenceImagePaths: referencePhotos,
      outputDir: assetsDir,
      baseName: `cover-${approved.label}`,
      dataDir,
    });

    // Pro gate returned upgrade hint
    if ("upgradeHint" in result) return result;

    // Update variant with new paths
    if (result.paths["16:9"]) {
      approved.imagePaths = { ...approved.imagePaths, "16:9": result.paths["16:9"] };
    }
    if (result.paths["4:3"]) {
      approved.imagePaths = { ...approved.imagePaths, "4:3": result.paths["4:3"] };
    }

    await saveCoverReview(contentId, review, dataDir);

    return {
      ok: result.ok,
      paths: result.paths,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}
