/**
 * wide-crop.test.ts — 公众号横版:21:9 优先、16:9 兜底、裁切降级
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodePng, decodePng } from "./png-crop.js";

vi.mock("../../adapters/image/gemini.js", () => ({ generateImage: vi.fn() }));

import { generateImage } from "../../adapters/image/gemini.js";
import { generateWideCover } from "./wide-crop.js";

const genMock = vi.mocked(generateImage);

function rows(width: number, height: number, channels: number): Buffer[] {
  const out: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * channels);
    for (let x = 0; x < width * channels; x++) row[x] = (x + y) & 0xff;
    out.push(row);
  }
  return out;
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-widecrop-"));
  genMock.mockReset();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const PROMPT = "Vertical 3:4 portrait orientation cover image. cinematic, bold Chinese text.";

describe("generateWideCover", () => {
  it("21:9 优先且 prompt 已适配;成功后裁到 2.35:1", async () => {
    genMock.mockImplementationOnce(async (opts) => {
      expect(opts.aspectRatio).toBe("21:9");
      expect(opts.model).toBe("gemini-native");
      expect(opts.prompt).toContain("21:9");
      expect(opts.prompt).not.toContain("3:4");
      const p = `${opts.outputPath}.png`;
      await fs.writeFile(p, encodePng(210, 90, 3, rows(210, 90, 3)));
      return { ok: true, imagePath: p, model: "m" };
    });
    const r = await generateWideCover({ originalPrompt: PROMPT, apiKey: "k", model: "auto", outputDir: dir, baseName: "cover-a-r1" });
    expect(r.ok).toBe(true);
    expect(r.ratioUsed).toBe("21:9");
    expect(r.cropped).toBe(true);
    expect(r.path).toContain("235x1");
    const decoded = decodePng(await fs.readFile(r.path!));
    expect(decoded.width).toBe(210);
    expect(decoded.height).toBe(Math.round(210 / 2.35));
  });

  it("21:9 失败 → 16:9 兜底", async () => {
    genMock.mockResolvedValueOnce({ ok: false, imagePath: "", model: "m", error: "ratio unsupported" });
    genMock.mockImplementationOnce(async (opts) => {
      expect(opts.aspectRatio).toBe("16:9");
      const p = `${opts.outputPath}.png`;
      await fs.writeFile(p, encodePng(160, 90, 3, rows(160, 90, 3)));
      return { ok: true, imagePath: p, model: "m" };
    });
    const r = await generateWideCover({ originalPrompt: PROMPT, apiKey: "k", model: "auto", outputDir: dir, baseName: "cover-b-r2" });
    expect(r.ratioUsed).toBe("16:9");
    expect(r.cropped).toBe(true);
    expect(decodePng(await fs.readFile(r.path!)).height).toBe(Math.round(160 / 2.35));
  });

  it("imagen-4 不试 21:9,直接 16:9", async () => {
    genMock.mockImplementationOnce(async (opts) => {
      expect(opts.aspectRatio).toBe("16:9");
      expect(opts.model).toBe("imagen-4");
      const p = `${opts.outputPath}.png`;
      await fs.writeFile(p, encodePng(160, 90, 3, rows(160, 90, 3)));
      return { ok: true, imagePath: p, model: "imagen" };
    });
    const r = await generateWideCover({ originalPrompt: PROMPT, apiKey: "k", model: "imagen-4", outputDir: dir, baseName: "cover-c-r1" });
    expect(r.ok).toBe(true);
    expect(genMock).toHaveBeenCalledTimes(1);
  });

  it("JPEG 输出 → 不裁,拷贝原图带 warning", async () => {
    genMock.mockImplementationOnce(async (opts) => {
      const p = `${opts.outputPath}.jpg`;
      await fs.writeFile(p, Buffer.from("fake-jpeg-bytes"));
      return { ok: true, imagePath: p, model: "m" };
    });
    const r = await generateWideCover({ originalPrompt: PROMPT, apiKey: "k", model: "auto", outputDir: dir, baseName: "cover-a-r3" });
    expect(r.ok).toBe(true);
    expect(r.cropped).toBe(false);
    expect(r.warning).toContain("裁切失败");
    expect(r.path).toContain("235x1.jpg");
    await expect(fs.access(r.path!)).resolves.toBeUndefined();
  });

  it("全部失败 → ok:false 聚合错误", async () => {
    genMock.mockResolvedValue({ ok: false, imagePath: "", model: "m", error: "quota" });
    const r = await generateWideCover({ originalPrompt: PROMPT, apiKey: "k", model: "auto", outputDir: dir, baseName: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("quota");
  });
});
