/**
 * Ratio Adapter — generates 16:9 and 4:3 versions from a finalized 3:4 cover.
 *
 * Strategy: re-generate using the original prompt with the new aspect ratio.
 * This produces better results than cropping/stretching.
 *
 * This is a Pro-only feature (gated by pro/gate.ts).
 */
import { generateImage, type GeminiModel, type AspectRatio } from "../../adapters/image/gemini.js";
import { requirePro, proGateResponse } from "../pro/gate.js";
import path from "node:path";

export interface RatioAdaptInput {
  /** Original image prompt used for the 3:4 version */
  originalPrompt: string;
  /** Gemini API key */
  apiKey: string;
  /** Model to use */
  model: GeminiModel;
  /** Reference image paths (same as used for 3:4) */
  referenceImagePaths?: string[];
  /** Base directory for saving (e.g. content assets dir) */
  outputDir: string;
  /** Base filename without extension (e.g. "cover-A") */
  baseName: string;
  /** Data dir for Pro gate check */
  dataDir?: string;
}

export interface RatioAdaptResult {
  ok: boolean;
  paths: {
    "16:9"?: string;
    "4:3"?: string;
  };
  errors: string[];
}

/**
 * Adapt a prompt to a different aspect ratio.
 * Replaces "Vertical 3:4 portrait orientation" with the target ratio description.
 */
function adaptPromptForRatio(prompt: string, ratio: AspectRatio): string {
  const ratioDescriptions: Record<string, string> = {
    "16:9": "Horizontal 16:9 widescreen landscape orientation",
    "4:3": "Square-ish 4:3 landscape orientation",
  };

  return prompt
    .replace(/Vertical 3:4 portrait orientation/i, ratioDescriptions[ratio] || ratio)
    .replace(/3:4/g, ratio);
}

/**
 * Generate 16:9 and 4:3 versions from a finalized 3:4 cover prompt.
 *
 * Pro-only: returns upgrade hint if user is on Free plan.
 */
export async function generateMultiRatio(
  input: RatioAdaptInput,
): Promise<RatioAdaptResult | { ok: false; error: string; upgradeHint: string; freeAlternative: string }> {
  // Pro gate check
  const gate = await requirePro("多比例封面生成", input.dataDir);
  if (gate) {
    return proGateResponse(
      "多比例封面生成（16:9 + 4:3）",
      "3:4 封面已生成。你可以用图片编辑工具手动裁剪为其他比例。",
    );
  }

  const ratios: AspectRatio[] = ["16:9", "4:3"];
  const paths: Record<string, string> = {};
  const errors: string[] = [];

  for (const ratio of ratios) {
    const adaptedPrompt = adaptPromptForRatio(input.originalPrompt, ratio);
    const safeName = ratio.replace(":", "x");
    const outputPath = path.join(input.outputDir, `${input.baseName}-${safeName}`);

    const result = await generateImage({
      prompt: adaptedPrompt,
      aspectRatio: ratio,
      model: input.model,
      apiKey: input.apiKey,
      referenceImagePaths: input.referenceImagePaths,
      outputPath,
    });

    if (result.ok) {
      paths[ratio] = result.imagePath;
    } else {
      errors.push(`${ratio}: ${result.error}`);
    }
  }

  return {
    ok: errors.length === 0,
    paths: {
      "16:9": paths["16:9"],
      "4:3": paths["4:3"],
    },
    errors,
  };
}
