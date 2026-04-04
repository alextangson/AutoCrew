import { describe, it, expect, vi } from "vitest";
import { JianyingExporter } from "./exporter.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Timeline type inline (to avoid cross-package import issues)
interface TTSSegment {
  id: string;
  text: string;
  estimatedDuration: number;
  start: number;
  asset: string | null;
  status: string;
}

interface VisualSegment {
  id: string;
  layer: number;
  type: "broll" | "card";
  prompt?: string;
  template?: string;
  data?: Record<string, unknown>;
  linkedTts: string[];
  opacity?: number;
  asset: string | null;
  status: string;
}

interface Timeline {
  version: "2.0";
  contentId: string;
  preset: string;
  aspectRatio: string;
  subtitle: { template: string; position: string };
  tracks: {
    tts: TTSSegment[];
    visual: VisualSegment[];
    subtitle: { asset: string | null; status: string };
  };
}

const sampleTimeline: Timeline = {
  version: "2.0",
  contentId: "test-123",
  preset: "knowledge-explainer",
  aspectRatio: "9:16",
  subtitle: { template: "modern-outline", position: "bottom" },
  tracks: {
    tts: [
      { id: "tts-001", text: "你好世界", estimatedDuration: 2, start: 0, asset: "/tmp/tts-001.mp3", status: "confirmed" },
      { id: "tts-002", text: "第二段", estimatedDuration: 1.5, start: 2, asset: "/tmp/tts-002.mp3", status: "confirmed" },
    ],
    visual: [
      { id: "vis-001", layer: 0, type: "card", template: "key-points", data: { items: ["a", "b"] }, linkedTts: ["tts-001"], asset: "/tmp/vis-001.png", status: "confirmed" },
      { id: "vis-002", layer: 0, type: "broll", prompt: "city", linkedTts: ["tts-002"], asset: "/tmp/vis-002.mp4", status: "confirmed" },
    ],
    subtitle: { asset: null, status: "pending" },
  },
};

describe("JianyingExporter", () => {
  it("converts timeline to Jianying draft", async () => {
    const exporter = new JianyingExporter();
    const result = await exporter.export(sampleTimeline, "/tmp/drafts/test-project");

    expect(result.path).toBe("/tmp/drafts/test-project");
    expect(result.format).toBe("jianying");
  });

  it("maps TTS segments to audio track", () => {
    const exporter = new JianyingExporter();
    const draft = exporter.timelineToDraft(sampleTimeline);

    const audioTracks = draft.tracks.filter((t: Record<string, unknown>) => t.type === "audio");
    expect(audioTracks.length).toBe(1);
    expect(draft.materials.audios.length).toBe(2);
  });

  it("maps card visuals to image and broll to video materials", () => {
    const exporter = new JianyingExporter();
    const draft = exporter.timelineToDraft(sampleTimeline);

    expect(draft.materials.videos.length).toBe(2);
  });

  it("adds subtitles from TTS text", () => {
    const exporter = new JianyingExporter();
    const draft = exporter.timelineToDraft(sampleTimeline);

    expect(draft.materials.texts.length).toBe(2);
  });

  it("skips segments without confirmed assets", () => {
    const timeline = {
      ...sampleTimeline,
      tracks: {
        ...sampleTimeline.tracks,
        tts: [
          { id: "tts-001", text: "你好", estimatedDuration: 1, start: 0, asset: null, status: "pending" },
        ],
        visual: [],
      },
    };
    const exporter = new JianyingExporter();
    const draft = exporter.timelineToDraft(timeline);

    expect(draft.materials.audios.length).toBe(0);
  });
});
