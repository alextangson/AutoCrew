/**
 * relay-cover.test.ts — 中转封面适配器:edits 优先/降级、精裁到目标比例、
 * 精裁失败降级原生尺寸。image-gen 全 mock,裁切走真 PNG。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodePng, decodePng } from "../../modules/cover/png-crop.js";

vi.mock("../../modules/publish/image-gen.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../modules/publish/image-gen.js")>();
  return { ...orig, generateImageViaRelay: vi.fn(), editImageViaRelay: vi.fn() };
});

import { generateImageViaRelay, editImageViaRelay, RelayEditUnsupportedError } from "../../modules/publish/image-gen.js";
import { generateCoverViaRelay } from "./relay-cover.js";

const genMock = vi.mocked(generateImageViaRelay);
const editMock = vi.mocked(editImageViaRelay);

function png(width: number, height: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 3);
    for (let i = 0; i < row.length; i++) row[i] = (i + y * 7) & 0xff;
    rows.push(row);
  }
  return encodePng(width, height, 3, rows);
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-relaycover-"));
  genMock.mockReset();
  editMock.mockReset();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const RELAY = { apiKey: "sk-relay", baseUrl: "https://relay.test/v1", model: "gpt-image-2" };
const PROMPT = "Vertical 3:4 portrait orientation cover image. Cinematic with bold Chinese text.";

describe("generateCoverViaRelay", () => {
  it("3:4:中转 1024x1536(2:3) 出图 → 精裁到 1024x1365;size/prompt 正确", async () => {
    genMock.mockResolvedValueOnce(png(1024, 1536));
    const r = await generateCoverViaRelay({ prompt: PROMPT, targetAspect: "3:4", outputPath: path.join(dir, "cover-a-r1"), relay: RELAY });
    expect(r.ok).toBe(true);
    expect(r.model).toBe("gpt-image-2");
    const call = genMock.mock.calls[0][0];
    expect(call.size).toBe("1024x1536");
    expect(call.prompt).toContain("Vertical 3:4");
    const out = decodePng(await fs.readFile(r.imagePath));
    expect(out.width).toBe(1024);
    expect(out.height).toBe(Math.round(1024 / (3 / 4))); // 1365
  });

  it("2.35:1:1536x1024(3:2) → 精裁 1536x654,prompt 措辞替换", async () => {
    genMock.mockResolvedValueOnce(png(1536, 1024));
    const r = await generateCoverViaRelay({ prompt: PROMPT, targetAspect: "2.35:1", outputPath: path.join(dir, "cover-a-r1-235x1"), relay: RELAY });
    expect(r.ok).toBe(true);
    const call = genMock.mock.calls[0][0];
    expect(call.size).toBe("1536x1024");
    expect(call.prompt).toContain("2.35:1");
    expect(call.prompt).not.toContain("3:4");
    const out = decodePng(await fs.readFile(r.imagePath));
    expect(out.width).toBe(1536);
    expect(out.height).toBe(Math.round(1536 / 2.35)); // 654
  });

  it("4:3:3:2 出图 → 裁列到 1365x1024", async () => {
    genMock.mockResolvedValueOnce(png(1536, 1024));
    const r = await generateCoverViaRelay({ prompt: PROMPT, targetAspect: "4:3", outputPath: path.join(dir, "cover-a-r1-4x3"), relay: RELAY });
    const out = decodePng(await fs.readFile(r.imagePath));
    expect(out.height).toBe(1024);
    expect(out.width).toBe(Math.round(1024 * (4 / 3))); // 1365
  });

  it("带参考图:先走 edits;不支持(4xx) → 降级 generations 带「未带人物」warning", async () => {
    const refPath = path.join(dir, "me.jpg");
    await fs.writeFile(refPath, Buffer.from("jpeg-bytes"));
    editMock.mockRejectedValueOnce(new RelayEditUnsupportedError("HTTP 404: no such endpoint"));
    genMock.mockResolvedValueOnce(png(1024, 1536));

    const r = await generateCoverViaRelay({ prompt: PROMPT, targetAspect: "3:4", referenceImagePaths: [refPath], outputPath: path.join(dir, "cover-b-r1"), relay: RELAY });
    expect(editMock).toHaveBeenCalledTimes(1);
    expect(editMock.mock.calls[0][0].referenceImagePaths).toEqual([refPath]);
    expect(genMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("未带人物");
  });

  it("edits 成功 → 不降级无 warning", async () => {
    const refPath = path.join(dir, "me.jpg");
    await fs.writeFile(refPath, Buffer.from("jpeg-bytes"));
    editMock.mockResolvedValueOnce(png(1024, 1536));
    const r = await generateCoverViaRelay({ prompt: PROMPT, targetAspect: "3:4", referenceImagePaths: [refPath], outputPath: path.join(dir, "cover-c-r1"), relay: RELAY });
    expect(genMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("中转回非 PNG(JPEG 字节) → 精裁降级,原样落盘带 warning", async () => {
    genMock.mockResolvedValueOnce(Buffer.from("\xff\xd8\xff fake jpeg", "binary"));
    const r = await generateCoverViaRelay({ prompt: PROMPT, targetAspect: "3:4", outputPath: path.join(dir, "cover-d-r1"), relay: RELAY });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("精裁失败");
    await expect(fs.access(r.imagePath)).resolves.toBeUndefined();
  });

  it("生图彻底失败 → ok:false 带错误", async () => {
    genMock.mockRejectedValueOnce(new Error("生图失败(已重试): quota"));
    const r = await generateCoverViaRelay({ prompt: PROMPT, targetAspect: "3:4", outputPath: path.join(dir, "x"), relay: RELAY });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("quota");
  });
});
