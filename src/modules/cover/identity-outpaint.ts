import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodePng, encodePng } from "./png-crop.js";

export type IdentityOutpaintAspect = "3:4" | "16:9" | "4:3" | "2.35:1";

const ASPECT_VALUE: Record<IdentityOutpaintAspect, number> = {
  "3:4": 3 / 4,
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "2.35:1": 2.35,
};

export interface IdentityOutpaintAssets {
  canvasPath: string;
  maskPath: string;
  workDir: string;
}

export interface NormalizedMaskRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rgbaPixel(row: Buffer, x: number, channels: number): [number, number, number, number] {
  const offset = x * channels;
  if (channels === 1) return [row[offset], row[offset], row[offset], 255];
  if (channels === 2) return [row[offset], row[offset], row[offset], row[offset + 1]];
  if (channels === 3) return [row[offset], row[offset + 1], row[offset + 2], 255];
  return [row[offset], row[offset + 1], row[offset + 2], row[offset + 3]];
}

/**
 * 把已批准的个人 IP 母版原像素放到目标比例透明画布中央。
 * mask 的透明区只包含新增画布，人物与原文字所在母版区域完全不允许重画。
 */
export async function prepareIdentityLockedOutpaint(
  sourceImagePath: string,
  targetAspect: IdentityOutpaintAspect,
): Promise<IdentityOutpaintAssets> {
  const decoded = decodePng(await fs.readFile(sourceImagePath));
  const sourceAspect = decoded.width / decoded.height;
  const target = ASPECT_VALUE[targetAspect];
  let canvasWidth = decoded.width;
  let canvasHeight = decoded.height;
  if (target > sourceAspect) canvasWidth = Math.round(decoded.height * target);
  else if (target < sourceAspect) canvasHeight = Math.round(decoded.width / target);
  if (canvasWidth === decoded.width && canvasHeight === decoded.height) {
    throw new Error(`母版已经是 ${targetAspect}，无需延展`);
  }

  const offsetX = Math.floor((canvasWidth - decoded.width) / 2);
  const offsetY = Math.floor((canvasHeight - decoded.height) / 2);
  const canvasRows = Array.from({ length: canvasHeight }, () => Buffer.alloc(canvasWidth * 4));
  const maskRows = Array.from({ length: canvasHeight }, () => {
    const row = Buffer.alloc(canvasWidth * 2);
    for (let x = 0; x < canvasWidth; x += 1) row[x * 2] = 255;
    return row;
  });

  for (let y = 0; y < decoded.height; y += 1) {
    const canvasRow = canvasRows[y + offsetY];
    const maskRow = maskRows[y + offsetY];
    const sourceRow = decoded.rows[y];
    for (let x = 0; x < decoded.width; x += 1) {
      const [red, green, blue, alpha] = rgbaPixel(sourceRow, x, decoded.channels);
      const targetX = x + offsetX;
      const canvasOffset = targetX * 4;
      canvasRow[canvasOffset] = red;
      canvasRow[canvasOffset + 1] = green;
      canvasRow[canvasOffset + 2] = blue;
      canvasRow[canvasOffset + 3] = alpha;
      maskRow[targetX * 2 + 1] = 255;
    }
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-cover-outpaint-"));
  const canvasPath = path.join(workDir, "identity-locked-canvas.png");
  const maskPath = path.join(workDir, "identity-locked-mask.png");
  await Promise.all([
    fs.writeFile(canvasPath, encodePng(canvasWidth, canvasHeight, 4, canvasRows)),
    fs.writeFile(maskPath, encodePng(canvasWidth, canvasHeight, 2, maskRows)),
  ]);
  return { canvasPath, maskPath, workDir };
}

export function identityLockedOutpaintPrompt(originalPrompt: string, targetAspect: IdentityOutpaintAspect): string {
  return [
    `Create the ${targetAspect} adaptation by masked outpainting only.`,
    "Image 1 contains the exact approved personal-IP master centered on a transparent target-ratio canvas.",
    "The mask is authoritative: edit only the transparent added bands; preserve every opaque master pixel exactly.",
    "Do not repaint, retouch, beautify, resize, move or reinterpret the creator, face, glasses, expression, hair, body, hands or existing typography.",
    "Extend only the existing background, structural forms, lighting and shadows into the new area with no seam, panel or split-screen boundary.",
    "Do not add, repeat, translate, distort or replace any text, logo, watermark, URL or character.",
    `Approved creative direction for side-area continuity only: ${originalPrompt}`,
  ].join(" ");
}

function boundedRegion(region: NormalizedMaskRegion): NormalizedMaskRegion {
  const x = Math.max(0, Math.min(1, region.x));
  const y = Math.max(0, Math.min(1, region.y));
  const width = Math.max(0, Math.min(1 - x, region.width));
  const height = Math.max(0, Math.min(1 - y, region.height));
  if (width < 0.02 || height < 0.02) throw new Error("局部框选区域太小，请重新框选");
  return { x, y, width, height };
}

/** 创建“框内可编辑、框外锁定”的 PNG mask；用于修脸、文字或单一局部。 */
export async function prepareLocalizedEditMask(
  sourceImagePath: string,
  rawRegion: NormalizedMaskRegion,
): Promise<{ maskPath: string; workDir: string }> {
  const decoded = decodePng(await fs.readFile(sourceImagePath));
  const region = boundedRegion(rawRegion);
  const left = Math.floor(region.x * decoded.width);
  const top = Math.floor(region.y * decoded.height);
  const right = Math.ceil((region.x + region.width) * decoded.width);
  const bottom = Math.ceil((region.y + region.height) * decoded.height);
  const feather = Math.max(2, Math.round(Math.min(decoded.width, decoded.height) * 0.008));
  const maskRows = Array.from({ length: decoded.height }, (_, y) => {
    const row = Buffer.alloc(decoded.width * 2);
    for (let x = 0; x < decoded.width; x += 1) {
      row[x * 2] = 255;
      const outsideX = x < left ? left - x : x >= right ? x - right + 1 : 0;
      const outsideY = y < top ? top - y : y >= bottom ? y - bottom + 1 : 0;
      const distance = Math.max(outsideX, outsideY);
      row[x * 2 + 1] = distance === 0 ? 0 : distance <= feather ? Math.round((distance / feather) * 255) : 255;
    }
    return row;
  });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-cover-local-edit-"));
  const maskPath = path.join(workDir, "localized-edit-mask.png");
  await fs.writeFile(maskPath, encodePng(decoded.width, decoded.height, 2, maskRows));
  return { maskPath, workDir };
}

export function localizedEditPrompt(originalPrompt: string, feedback: string): string {
  return [
    "Perform a masked local edit on the approved cover.",
    "The mask is authoritative: change only the transparent selected region and preserve every opaque pixel exactly.",
    `Requested local correction: ${feedback}.`,
    "Keep the same creator identity, facial geometry, glasses, expression, body, typography, composition, lighting and material outside the selected region.",
    "If the selected region includes skin, keep it clean, photographic and low-noise: no dirty grain, crackle, embossed texture, invented freckles, acne marks or waxy beauty filter.",
    "Do not add unrelated text, logos, watermarks, URLs, extra people, limbs or objects.",
    `Approved creative direction for continuity only: ${originalPrompt}`,
  ].join(" ");
}
