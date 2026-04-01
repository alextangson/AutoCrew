import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Gemini adapter and Pro gate before importing
vi.mock("../../adapters/image/gemini.js", () => ({
  generateImage: vi.fn(),
}));

vi.mock("../pro/gate.js", () => ({
  requirePro: vi.fn(),
  proGateResponse: vi.fn((name: string, alt: string) => ({
    ok: false,
    error: `「${name}」是 Pro 版功能。`,
    upgradeHint: "运行 autocrew upgrade 了解 Pro 版详情。",
    freeAlternative: alt,
  })),
}));

import { generateMultiRatio, type RatioAdaptInput } from "../cover/ratio-adapter.js";
import { generateImage } from "../../adapters/image/gemini.js";
import { requirePro } from "../pro/gate.js";

const mockGenerateImage = vi.mocked(generateImage);
const mockRequirePro = vi.mocked(requirePro);

const baseInput: RatioAdaptInput = {
  originalPrompt: "Vertical 3:4 portrait orientation cover image. cinematic style.",
  apiKey: "test-key",
  model: "auto",
  outputDir: "/tmp/test-covers",
  baseName: "cover-a",
  dataDir: "/tmp/test-autocrew",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateMultiRatio", () => {
  it("returns Pro gate response when user is Free", async () => {
    mockRequirePro.mockResolvedValue({
      ok: false,
      error: "Pro required",
      upgradeHint: "upgrade",
    });

    const result = await generateMultiRatio(baseInput);
    expect("upgradeHint" in result).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("generates 16:9 and 4:3 when Pro", async () => {
    mockRequirePro.mockResolvedValue(null); // Pro user
    mockGenerateImage.mockResolvedValue({
      ok: true,
      imagePath: "/tmp/test-covers/cover-a-16x9.png",
      model: "gemini-native",
    });

    const result = await generateMultiRatio(baseInput);

    // Should have called generateImage twice (16:9 and 4:3)
    expect(mockGenerateImage).toHaveBeenCalledTimes(2);

    // Check that aspect ratios were passed correctly
    const calls = mockGenerateImage.mock.calls;
    expect(calls[0][0].aspectRatio).toBe("16:9");
    expect(calls[1][0].aspectRatio).toBe("4:3");
  });

  it("adapts prompt for different ratios", async () => {
    mockRequirePro.mockResolvedValue(null);
    mockGenerateImage.mockResolvedValue({
      ok: true,
      imagePath: "/tmp/test.png",
      model: "gemini-native",
    });

    await generateMultiRatio(baseInput);

    const calls = mockGenerateImage.mock.calls;
    // 16:9 prompt should NOT contain "Vertical 3:4"
    expect(calls[0][0].prompt).not.toContain("Vertical 3:4");
    expect(calls[0][0].prompt).toContain("16:9");
    // 4:3 prompt should NOT contain "Vertical 3:4"
    expect(calls[1][0].prompt).not.toContain("Vertical 3:4");
    expect(calls[1][0].prompt).toContain("4:3");
  });

  it("reports errors for failed generations", async () => {
    mockRequirePro.mockResolvedValue(null);
    mockGenerateImage
      .mockResolvedValueOnce({ ok: true, imagePath: "/tmp/ok.png", model: "gemini-native" })
      .mockResolvedValueOnce({ ok: false, imagePath: "", model: "gemini-native", error: "API error" });

    const result = await generateMultiRatio(baseInput);
    // Should not be fully ok since one failed
    if (!("upgradeHint" in result)) {
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.paths["16:9"]).toBeTruthy();
      expect(result.paths["4:3"]).toBeUndefined();
    }
  });

  it("passes reference images through", async () => {
    mockRequirePro.mockResolvedValue(null);
    mockGenerateImage.mockResolvedValue({
      ok: true,
      imagePath: "/tmp/test.png",
      model: "gemini-native",
    });

    await generateMultiRatio({
      ...baseInput,
      referenceImagePaths: ["/tmp/photo.jpg"],
    });

    for (const call of mockGenerateImage.mock.calls) {
      expect(call[0].referenceImagePaths).toEqual(["/tmp/photo.jpg"]);
    }
  });
});
