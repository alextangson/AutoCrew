import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadIdentitySource } from "./identity-library.js";
import { generateIdentityPortraitCandidates } from "./identity-generator.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-portrait-generator-"));
});
afterEach(async () => fs.rm(dataDir, { recursive: true, force: true }));

describe("generateIdentityPortraitCandidates", () => {
  it("refuses to invent a face without a real source photo", async () => {
    await expect(generateIdentityPortraitCandidates(dataDir)).rejects.toThrow("请先上传");
  });

  it("creates three reviewable portrait directions with identity references", async () => {
    await uploadIdentitySource(PNG.toString("base64"), dataDir);
    const relayGenerate = vi.fn(
      async (
        input: Parameters<NonNullable<Parameters<typeof generateIdentityPortraitCandidates>[1]>["relayGenerate"]>[0],
      ) => {
        const imagePath = `${input.outputPath}.png`;
        await fs.writeFile(imagePath, PNG);
        return { ok: true, imagePath, model: "test-image" };
      },
    );
    const result = await generateIdentityPortraitCandidates(dataDir, {
      now: () => 1_700_000_000_000,
      resolveProvider: async () => ({
        provider: "relay",
        ok: true,
        relay: { apiKey: "secret", baseUrl: "https://example.test", model: "test-image" },
        gemini: { apiKey: null, model: "auto", source: "none" },
      }),
      relayGenerate,
    });

    expect(result).toMatchObject({ generated: 3, failed: 0 });
    expect(relayGenerate).toHaveBeenCalledTimes(3);
    expect(relayGenerate.mock.calls[0][0].referenceImagePaths).toHaveLength(1);
    expect((await fs.stat(result.files[0])).mode & 0o777).toBe(0o600);
  });
});
