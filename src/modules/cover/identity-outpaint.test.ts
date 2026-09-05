import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodePng, encodePng } from "./png-crop.js";
import {
  identityLockedOutpaintPrompt,
  localizedEditPrompt,
  prepareIdentityLockedOutpaint,
  prepareLocalizedEditMask,
} from "./identity-outpaint.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

describe("prepareIdentityLockedOutpaint", () => {
  it("3:4 母版转 4:3 时只把左右新增区设为可编辑", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-outpaint-source-"));
    cleanup.push(sourceDir);
    const sourcePath = path.join(sourceDir, "master.png");
    const rows = Array.from({ length: 12 }, (_, y) =>
      Buffer.from(Array.from({ length: 9 * 3 }, (_, index) => (index + y) % 255)),
    );
    await fs.writeFile(sourcePath, encodePng(9, 12, 3, rows));

    const assets = await prepareIdentityLockedOutpaint(sourcePath, "4:3");
    cleanup.push(assets.workDir);
    const canvas = decodePng(await fs.readFile(assets.canvasPath));
    const mask = decodePng(await fs.readFile(assets.maskPath));

    expect([canvas.width, canvas.height, canvas.channels]).toEqual([16, 12, 4]);
    expect([mask.width, mask.height, mask.channels]).toEqual([16, 12, 2]);
    expect(mask.rows[5][1]).toBe(0);
    expect(mask.rows[5][3 * 2 + 1]).toBe(255);
    expect(mask.rows[5][11 * 2 + 1]).toBe(255);
    expect(mask.rows[5][15 * 2 + 1]).toBe(0);
    expect(canvas.rows[5].subarray(3 * 4, 12 * 4).some((value) => value !== 0)).toBe(true);
  });

  it("延展提示词明确禁止重画人物与原文字", () => {
    const prompt = identityLockedOutpaintPrompt("oxblood scene", "4:3");
    expect(prompt).toContain("masked outpainting only");
    expect(prompt).toContain("preserve every opaque master pixel exactly");
    expect(prompt).toContain("Do not repaint");
  });

  it("局部修订 mask 只把框内设为透明可编辑，并在边缘羽化", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-local-mask-source-"));
    cleanup.push(sourceDir);
    const sourcePath = path.join(sourceDir, "master.png");
    await fs.writeFile(sourcePath, encodePng(100, 100, 3, Array.from({ length: 100 }, () => Buffer.alloc(300, 80))));

    const assets = await prepareLocalizedEditMask(sourcePath, { x: 0.3, y: 0.2, width: 0.4, height: 0.5 });
    cleanup.push(assets.workDir);
    const mask = decodePng(await fs.readFile(assets.maskPath));
    expect(mask.rows[50][50 * 2 + 1]).toBe(0);
    expect(mask.rows[5][5 * 2 + 1]).toBe(255);
    expect(mask.rows[20][29 * 2 + 1]).toBeGreaterThan(0);
    expect(mask.rows[20][29 * 2 + 1]).toBeLessThan(255);
  });

  it("局部提示词把用户意见限制在透明区域", () => {
    const prompt = localizedEditPrompt("red editorial cover", "清理脸部脏纹");
    expect(prompt).toContain("change only the transparent selected region");
    expect(prompt).toContain("清理脸部脏纹");
    expect(prompt).toContain("preserve every opaque pixel exactly");
  });
});
