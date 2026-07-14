/**
 * 公众号横版封面(2.35:1):Gemini 没有该原生比例——先出 21:9(≈2.333,几乎无损),
 * 失败退 16:9,再垂直居中裁到 2.35:1。imagen-4 不支持 21:9,直接走 16:9。
 * 裁切失败(JPEG 输出/罕见 PNG 形态)不阻断:交付未裁切宽幅原图并带 warning
 * (21:9 与 2.35:1 只差 0.7%,公众号后台可微调)。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { generateImage, type GeminiModel, type AspectRatio } from "../../adapters/image/gemini.js";
import { cropPngVerticalCenter, PngUnsupportedError } from "./png-crop.js";

export const WECHAT_BANNER_ASPECT = 2.35;

export interface WideCoverResult {
  ok: boolean;
  path?: string;
  ratioUsed?: "21:9" | "16:9";
  cropped: boolean;
  warning?: string;
  error?: string;
}

function adaptPromptForWide(prompt: string, ratio: AspectRatio): string {
  const desc =
    ratio === "21:9"
      ? "Ultra-wide 21:9 editorial banner orientation cover image"
      : "Horizontal 16:9 widescreen landscape orientation cover image";
  return prompt.replace(/Vertical 3:4 portrait orientation cover image/i, desc).replace(/3:4/g, ratio);
}

export async function generateWideCover(input: {
  originalPrompt: string;
  apiKey: string;
  model: GeminiModel;
  referenceImagePaths?: string[];
  outputDir: string;
  baseName: string;
}): Promise<WideCoverResult> {
  const attempts: Array<{ ratio: "21:9" | "16:9"; model: GeminiModel }> =
    input.model === "imagen-4"
      ? [{ ratio: "16:9", model: "imagen-4" }]
      : [
          { ratio: "21:9", model: "gemini-native" },
          { ratio: "16:9", model: input.model },
        ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    const result = await generateImage({
      prompt: adaptPromptForWide(input.originalPrompt, attempt.ratio),
      aspectRatio: attempt.ratio,
      model: attempt.model,
      apiKey: input.apiKey,
      referenceImagePaths: input.referenceImagePaths,
      outputPath: path.join(input.outputDir, `${input.baseName}-wide`),
    });
    if (!result.ok) {
      errors.push(`${attempt.ratio}: ${result.error}`);
      continue;
    }
    return cropToBanner(result.imagePath, input.outputDir, input.baseName, attempt.ratio);
  }
  return { ok: false, cropped: false, error: errors.join("；") };
}

async function cropToBanner(
  sourcePath: string,
  outputDir: string,
  baseName: string,
  ratioUsed: "21:9" | "16:9",
): Promise<WideCoverResult> {
  const ext = path.extname(sourcePath).toLowerCase();
  const outPath = path.join(outputDir, `${baseName}-235x1${ext || ".png"}`);
  try {
    if (ext !== ".png") throw new PngUnsupportedError(`非 PNG 输出(${ext || "无扩展名"})`);
    const cropped = cropPngVerticalCenter(await fs.readFile(sourcePath), WECHAT_BANNER_ASPECT);
    await fs.writeFile(outPath, cropped);
    return { ok: true, path: outPath, ratioUsed, cropped: true };
  } catch (err) {
    await fs.copyFile(sourcePath, outPath);
    return {
      ok: true,
      path: outPath,
      ratioUsed,
      cropped: false,
      warning: `裁切失败(${err instanceof Error ? err.message : String(err)}),交付未裁切的 ${ratioUsed} 原图`,
    };
  }
}
