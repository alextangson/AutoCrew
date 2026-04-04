import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderTimeline, type RenderOptions } from "./render.js";

interface Timeline {
  version: "2.0";
  contentId: string;
  preset: string;
  aspectRatio: string;
  subtitle: { template: string; position: string };
  tracks: {
    tts: { id: string; text: string; estimatedDuration: number; start: number; asset: string | null; status: string }[];
    visual: { id: string; layer: number; type: "broll" | "card"; template?: string; data?: Record<string, unknown>; linkedTts: string[]; asset: string | null; status: string; prompt?: string }[];
    subtitle: { asset: string | null; status: string };
  };
}

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

const mockTTS = {
  generate: vi.fn().mockResolvedValue({ path: "/tmp/tts.mp3", duration: 2, format: "mp3" }),
  estimateDuration: vi.fn().mockReturnValue(2),
  listVoices: vi.fn().mockResolvedValue([]),
};

const mockScreenshot = {
  capture: vi.fn().mockResolvedValue({ path: "/tmp/card.png", width: 1080, height: 1920, format: "png" }),
};

const mockExporter = {
  export: vi.fn().mockResolvedValue({ path: "/tmp/draft", format: "jianying" }),
};

function makeTimeline(): Timeline {
  return {
    version: "2.0",
    contentId: "test-123",
    preset: "knowledge-explainer",
    aspectRatio: "9:16",
    subtitle: { template: "modern-outline", position: "bottom" },
    tracks: {
      tts: [
        { id: "tts-001", text: "\u4f60\u597d\u4e16\u754c", estimatedDuration: 2, start: 0, asset: null, status: "confirmed" },
      ],
      visual: [
        { id: "vis-001", layer: 0, type: "card", template: "key-points", data: { items: ["a"] }, linkedTts: ["tts-001"], asset: null, status: "confirmed" },
      ],
      subtitle: { asset: null, status: "pending" },
    },
  };
}

describe("renderTimeline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("generates TTS for all confirmed segments without assets", async () => {
    await renderTimeline({
      timeline: makeTimeline(),
      outputDir: "/tmp/render",
      tts: mockTTS,
      screenshot: mockScreenshot,
      exporter: mockExporter,
      voice: { voiceId: "BV700_V2_streaming" },
    });

    expect(mockTTS.generate).toHaveBeenCalledOnce();
    expect(mockTTS.generate.mock.calls[0][0]).toBe("\u4f60\u597d\u4e16\u754c");
  });

  it("screenshots card segments without assets", async () => {
    await renderTimeline({
      timeline: makeTimeline(),
      outputDir: "/tmp/render",
      tts: mockTTS,
      screenshot: mockScreenshot,
      exporter: mockExporter,
      voice: { voiceId: "BV700_V2_streaming" },
    });

    expect(mockScreenshot.capture).toHaveBeenCalledOnce();
  });

  it("exports after asset generation", async () => {
    await renderTimeline({
      timeline: makeTimeline(),
      outputDir: "/tmp/render",
      tts: mockTTS,
      screenshot: mockScreenshot,
      exporter: mockExporter,
      voice: { voiceId: "BV700_V2_streaming" },
    });

    expect(mockExporter.export).toHaveBeenCalledOnce();
  });

  it("skips TTS for segments that already have assets", async () => {
    const base = makeTimeline();
    const withAssets = {
      ...base,
      tracks: {
        ...base.tracks,
        tts: [
          { id: "tts-001", text: "\u4f60\u597d", estimatedDuration: 2, start: 0, asset: "/existing.mp3", status: "confirmed" },
        ],
      },
    };

    await renderTimeline({
      timeline: withAssets,
      outputDir: "/tmp/render",
      tts: mockTTS,
      screenshot: mockScreenshot,
      exporter: mockExporter,
      voice: { voiceId: "BV700_V2_streaming" },
    });

    expect(mockTTS.generate).not.toHaveBeenCalled();
  });

  it("returns export result", async () => {
    const result = await renderTimeline({
      timeline: makeTimeline(),
      outputDir: "/tmp/render",
      tts: mockTTS,
      screenshot: mockScreenshot,
      exporter: mockExporter,
      voice: { voiceId: "BV700_V2_streaming" },
    });

    expect(result.path).toBe("/tmp/draft");
    expect(result.format).toBe("jianying");
  });
});
