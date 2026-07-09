/**
 * 封面·中转适配器(V5.6.1 创始人裁决:生图从 Gemini 切 image2/OpenAI 兼容中转)。
 * 中转只接受固定尺寸集(1024x1536 / 1536x1024 / 1024x1024)——先按目标比例取
 * 最近尺寸出图,再 png-crop 居中精裁到目标比例;精裁失败降级交付原生尺寸带 warning。
 * 参考照片(人物一致性)走 /images/edits;中转不支持(4xx)自动降级 generations 并
 * 透出「未带人物」warning——降级即最终行为,不硬凑。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  generateImageViaRelay,
  editImageViaRelay,
  RelayEditUnsupportedError,
} from "../../modules/publish/image-gen.js";
import { cropPngCenterToAspect } from "../../modules/cover/png-crop.js";

export type CoverAspect = "3:4" | "2.35:1" | "16:9" | "4:3";

export interface RelayCoverInput {
  prompt: string;
  targetAspect: CoverAspect;
  referenceImagePaths?: string[];
  /** 不带扩展名;函数落 .png */
  outputPath: string;
  relay: { apiKey: string; baseUrl: string; model: string };
  timeoutMs?: number;
}

export interface RelayCoverResult {
  ok: boolean;
  imagePath: string;
  model: string;
  /** 参考图降级/精裁降级说明(不阻断) */
  warning?: string;
  error?: string;
}

/** 中转合法尺寸里离目标比例最近的一档 */
const ASPECT_TO_SIZE: Record<CoverAspect, string> = {
  "3:4": "1024x1536",
  "2.35:1": "1536x1024",
  "16:9": "1536x1024",
  "4:3": "1536x1024",
};

const ASPECT_VALUE: Record<CoverAspect, number> = {
  "3:4": 3 / 4,
  "2.35:1": 2.35,
  "16:9": 16 / 9,
  "4:3": 4 / 3,
};

export const ORIENTATION_TEXT: Record<CoverAspect, string> = {
  "3:4": "Vertical 3:4 portrait orientation cover image",
  "2.35:1": "Ultra-wide 2.35:1 cinematic banner orientation cover image",
  "16:9": "Horizontal 16:9 widescreen landscape orientation cover image",
  "4:3": "Horizontal 4:3 landscape orientation cover image",
};

/**
 * prompt 比例措辞适配:设计方案按主比例写就,适配其他比例时只换方向词——
 * 主体/光影/大字/禁止项全保留,这就是「多比例风格统一」的机制(同方案重渲染)。
 */
export function adaptCoverPrompt(prompt: string, aspect: CoverAspect): string {
  if (prompt.includes(ORIENTATION_TEXT[aspect])) return prompt;
  let out = prompt;
  for (const text of Object.values(ORIENTATION_TEXT)) {
    out = out.replace(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), ORIENTATION_TEXT[aspect]);
  }
  return out.replace(/\b(3:4|16:9|4:3|2\.35:1)\b/g, aspect);
}

async function fetchImageBytes(input: RelayCoverInput, prompt: string, size: string): Promise<{ buf: Buffer; warning?: string }> {
  const refs = (input.referenceImagePaths ?? []).slice(0, 3);
  const base = { ...input.relay, prompt, size, timeoutMs: input.timeoutMs };
  if (refs.length === 0) {
    return { buf: await generateImageViaRelay(base) };
  }
  try {
    return { buf: await editImageViaRelay({ ...base, referenceImagePaths: refs }) };
  } catch (err) {
    if (!(err instanceof RelayEditUnsupportedError)) throw err;
    const buf = await generateImageViaRelay(base);
    return { buf, warning: "中转不支持参考图(/images/edits),本次未带人物形象" };
  }
}

export async function generateCoverViaRelay(input: RelayCoverInput): Promise<RelayCoverResult> {
  const prompt = adaptCoverPrompt(input.prompt, input.targetAspect);
  const size = ASPECT_TO_SIZE[input.targetAspect];

  let buf: Buffer;
  let warning: string | undefined;
  try {
    ({ buf, warning } = await fetchImageBytes(input, prompt, size));
  } catch (err) {
    return { ok: false, imagePath: "", model: input.relay.model, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    buf = cropPngCenterToAspect(buf, ASPECT_VALUE[input.targetAspect]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warning = [warning, `精裁失败(${msg}),交付中转原生尺寸 ${size}`].filter(Boolean).join("；");
  }

  const outPath = `${input.outputPath}.png`;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
  return { ok: true, imagePath: outPath, model: input.relay.model, ...(warning ? { warning } : {}) };
}
