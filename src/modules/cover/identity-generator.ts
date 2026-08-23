import fs from "node:fs/promises";
import path from "node:path";
import { generateImage } from "../../adapters/image/gemini.js";
import { generateCoverViaRelay } from "../../adapters/image/relay-cover.js";
import { resolveCoverProvider } from "./provider.js";
import { loadCoverStyleProfile, orderCoverReferencePhotos } from "./style-profile.js";
import { generatedPortraitDir, listIdentitySourcePaths, recordGeneratedPortraits } from "./identity-library.js";

export interface PortraitDirection {
  id: string;
  label: string;
  direction: string;
}

export interface GeneratedPortraitResult {
  generated: number;
  failed: number;
  files: string[];
  errors: string[];
  warnings: string[];
}

export const PORTRAIT_DIRECTIONS: PortraitDirection[] = [
  {
    id: "confident",
    label: "克制有判断力",
    direction:
      "a composed, confident expression with direct eye contact, subtle tension in the brows, relaxed mouth, stylish creator-director presence",
  },
  {
    id: "skeptical",
    label: "审视感侧身",
    direction:
      "a three-quarter pose with a controlled skeptical raised-brow expression, intelligent and sharp rather than blank or comedic",
  },
  {
    id: "expressive",
    label: "明确夸张表达",
    direction:
      "an intentional expressive speaking moment with one clean hand gesture, energetic and magnetic but still flattering and editorial",
  },
];

function portraitPrompt(direction: PortraitDirection): string {
  return [
    "Vertical 3:4 editorial portrait photography for a personal brand reference library, no poster typography.",
    "The subject MUST be the same person as the real reference photos. Preserve exact facial identity, face shape, eyes, eyebrows, nose, lips, current hairstyle and everyday thin-frame glasses.",
    `Expression and pose: ${direction.direction}.`,
    "Frame from chest or waist up with clean separation around the head, shoulders and hands, leaving useful composition room for future cover design.",
    "Wardrobe: structured dark contemporary jacket or knitwear, stylish creative director rather than stereotypical programmer; masculine, restrained and modern.",
    "Lighting: clean cinematic editorial key light, realistic skin, low grain on the person, crisp glasses and hair, no plastic retouching.",
    "Background: simple warm neutral, deep red, charcoal or off-white studio field; no computer screens, code, server racks or generic AI decoration.",
    "No text, no logo, no watermark, no transparent body, no heavy film grain on skin, no feminized styling, no generic Asian male face, no identity drift.",
  ].join(" ");
}

export async function generateIdentityPortraitCandidates(
  dataDir?: string,
  deps?: {
    relayGenerate?: typeof generateCoverViaRelay;
    geminiGenerate?: typeof generateImage;
    resolveProvider?: typeof resolveCoverProvider;
    now?: () => number;
  },
): Promise<GeneratedPortraitResult> {
  const sourcePaths = await listIdentitySourcePaths(dataDir);
  if (sourcePaths.length === 0) throw new Error("请先上传至少 1 张真实照片；建议 3–5 张再生成备选肖像");
  const profile = await loadCoverStyleProfile(dataDir);
  const refs = orderCoverReferencePhotos(sourcePaths, profile).slice(0, 3);
  const resolveProviderImpl = deps?.resolveProvider ?? resolveCoverProvider;
  const provider = await resolveProviderImpl(dataDir);
  if (!provider.ok) throw new Error(provider.hint ?? "封面生图服务未配置");
  if (provider.provider === "gemini" && provider.gemini.model === "imagen-4") {
    throw new Error("Imagen 4 不支持身份参考图；请把封面模型切到 Gemini Native/Auto，或使用支持 images/edits 的中转");
  }
  const outDir = generatedPortraitDir(dataDir);
  await fs.mkdir(outDir, { recursive: true });
  const relayGenerate = deps?.relayGenerate ?? generateCoverViaRelay;
  const geminiGenerate = deps?.geminiGenerate ?? generateImage;
  const stamp = (deps?.now ?? Date.now)();

  const results = await Promise.all(
    PORTRAIT_DIRECTIONS.map(async (direction, index) => {
      const baseName = `portrait-${direction.id}-${stamp}-${index + 1}`;
      const outputBase = path.join(outDir, baseName);
      const prompt = portraitPrompt(direction);
      if (provider.provider === "relay" && provider.relay) {
        const result = await relayGenerate({
          prompt,
          targetAspect: "3:4",
          referenceImagePaths: refs,
          outputPath: outputBase,
          relay: provider.relay,
        });
        if (!result.ok || !result.imagePath) {
          return { ok: false as const, label: direction.label, error: result.error ?? "未返回图片" };
        }
        if (result.warning?.includes("未带人物")) {
          await fs.unlink(result.imagePath).catch(() => {});
          return {
            ok: false as const,
            label: direction.label,
            error: "当前中转不支持身份参考图，已拒绝保存可能不像本人的结果",
          };
        }
        await fs.chmod(result.imagePath, 0o600).catch(() => {});
        return {
          ok: true as const,
          filename: path.basename(result.imagePath),
          label: direction.label,
          prompt,
          model: result.model,
          warning: result.warning,
        };
      }
      const result = await geminiGenerate({
        prompt,
        aspectRatio: "3:4",
        model: "gemini-native",
        apiKey: provider.gemini.apiKey ?? "",
        referenceImagePaths: refs,
        outputPath: outputBase,
      });
      if (!result.ok || !result.imagePath) {
        return { ok: false as const, label: direction.label, error: result.error ?? "未返回图片" };
      }
      await fs.chmod(result.imagePath, 0o600).catch(() => {});
      return {
        ok: true as const,
        filename: path.basename(result.imagePath),
        label: direction.label,
        prompt,
        model: result.model,
        warning: undefined,
      };
    }),
  );

  const succeeded = results.filter((result): result is Extract<(typeof results)[number], { ok: true }> => result.ok);
  await recordGeneratedPortraits(
    succeeded.map((result) => ({
      filename: result.filename,
      label: result.label,
      prompt: result.prompt,
      model: result.model,
      createdAt: new Date(stamp).toISOString(),
    })),
    dataDir,
  );
  return {
    generated: succeeded.length,
    failed: results.length - succeeded.length,
    files: succeeded.map((result) => path.join(outDir, result.filename)),
    errors: results
      .filter((result): result is Extract<(typeof results)[number], { ok: false }> => !result.ok)
      .map((result) => `${result.label}: ${result.error}`),
    warnings: succeeded.flatMap((result) => (result.warning ? [result.warning] : [])),
  };
}
