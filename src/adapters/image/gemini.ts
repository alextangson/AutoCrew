/**
 * Gemini Image Adapter — generates images via Gemini API.
 *
 * Supports two models:
 * - gemini-native: Gemini 2.5 Flash Image (multimodal output, supports reference images)
 * - imagen-4: Imagen 4.0 (text-to-image only, being deprecated June 2026)
 *
 * "auto" mode tries gemini-native first (recommended), falls back to imagen-4.
 */
import fs from "node:fs/promises";
import path from "node:path";

// --- Types ---

export type GeminiModel = "gemini-native" | "imagen-4" | "auto";
export type AspectRatio = "3:4" | "16:9" | "4:3" | "1:1";

export interface GeminiImageOptions {
  prompt: string;
  aspectRatio: AspectRatio;
  model: GeminiModel;
  apiKey: string;
  /** Optional reference image paths (e.g. personal IP photos) */
  referenceImagePaths?: string[];
  /** Where to save the generated image */
  outputPath: string;
  /** Image resolution: "1K" | "2K". Default "1K" */
  resolution?: string;
}

export interface GeminiImageResult {
  ok: boolean;
  imagePath: string;
  model: string;
  mimeType?: string;
  error?: string;
}

// --- Constants ---

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_NATIVE = "gemini-2.5-flash-preview-image-generation";
const MODEL_IMAGEN = "imagen-4.0-generate-001";

// --- Helpers ---

async function fileToBase64(filePath: string): Promise<{ data: string; mimeType: string }> {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  const mimeType = mimeMap[ext] || "image/jpeg";
  const buffer = await fs.readFile(filePath);
  return { data: buffer.toString("base64"), mimeType };
}

// --- Gemini Native (2.5 Flash Image) ---

async function generateNative(options: GeminiImageOptions): Promise<GeminiImageResult> {
  const { prompt, aspectRatio, apiKey, referenceImagePaths, outputPath, resolution } = options;

  // Build parts array
  const parts: any[] = [{ text: prompt }];

  // Add reference images if provided
  if (referenceImagePaths?.length) {
    for (const refPath of referenceImagePaths) {
      try {
        const { data, mimeType } = await fileToBase64(refPath);
        parts.push({ inline_data: { mime_type: mimeType, data } });
      } catch {
        // Skip unreadable reference images
      }
    }
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio,
        imageSize: resolution || "1K",
      },
    },
  };

  const url = `${GEMINI_API_BASE}/models/${MODEL_NATIVE}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, imagePath: "", model: MODEL_NATIVE, error: `Gemini API ${res.status}: ${errText}` };
  }

  const json = (await res.json()) as any;

  // Extract image from response
  const candidates = json.candidates || [];
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) {
        const buffer = Buffer.from(part.inlineData.data, "base64");
        const mimeType = part.inlineData.mimeType || "image/png";
        const ext = mimeType.includes("jpeg") ? ".jpg" : ".png";
        const finalPath = outputPath.endsWith(ext) ? outputPath : outputPath + ext;

        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(finalPath, buffer);

        return { ok: true, imagePath: finalPath, model: MODEL_NATIVE, mimeType };
      }
    }
  }

  return { ok: false, imagePath: "", model: MODEL_NATIVE, error: "No image in response" };
}

// --- Imagen 4 ---

async function generateImagen(options: GeminiImageOptions): Promise<GeminiImageResult> {
  const { prompt, aspectRatio, apiKey, outputPath } = options;

  // Imagen 4 uses a different API format
  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio,
    },
  };

  const url = `${GEMINI_API_BASE}/models/${MODEL_IMAGEN}:predict?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, imagePath: "", model: MODEL_IMAGEN, error: `Imagen API ${res.status}: ${errText}` };
  }

  const json = (await res.json()) as any;
  const predictions = json.predictions || [];

  if (predictions.length > 0 && predictions[0].bytesBase64Encoded) {
    const buffer = Buffer.from(predictions[0].bytesBase64Encoded, "base64");
    const finalPath = outputPath.endsWith(".png") ? outputPath : outputPath + ".png";

    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(finalPath, buffer);

    return { ok: true, imagePath: finalPath, model: MODEL_IMAGEN, mimeType: "image/png" };
  }

  return { ok: false, imagePath: "", model: MODEL_IMAGEN, error: "No image in Imagen response" };
}

// --- Public API ---

/**
 * Generate an image using Gemini API.
 *
 * "auto" mode tries gemini-native first, falls back to imagen-4.
 * gemini-native supports reference images; imagen-4 does not.
 */
export async function generateImage(options: GeminiImageOptions): Promise<GeminiImageResult> {
  const model = options.model || "auto";

  if (model === "gemini-native") {
    return generateNative(options);
  }

  if (model === "imagen-4") {
    return generateImagen(options);
  }

  // auto: try native first, fall back to imagen-4
  const nativeResult = await generateNative(options);
  if (nativeResult.ok) return nativeResult;

  // Fallback — imagen-4 doesn't support reference images
  const imagenOptions = { ...options, referenceImagePaths: undefined };
  return generateImagen(imagenOptions);
}

/**
 * List available personal IP reference photos from the templates directory.
 */
export async function listReferencePhotos(dataDir?: string): Promise<string[]> {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  const dir = path.join(dataDir || path.join(home, ".autocrew"), "covers", "templates");
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
