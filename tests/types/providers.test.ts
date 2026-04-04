import { describe, it, expect } from "vitest";
import type {
  TTSProvider,
  VideoProvider,
  CompositorProvider,
  Voice,
  VoiceConfig,
  AudioAsset,
  VideoConfig,
  VideoAsset,
  VideoFile,
  ProjectFile,
  ExportFormat,
  AssetMap,
} from "../../src/types/providers.js";
import type { AspectRatio, Timeline } from "../../src/types/timeline.js";

function makeTimeline(): Timeline {
  return {
    version: "2.0",
    contentId: "test-123",
    preset: "knowledge-explainer",
    aspectRatio: "16:9",
    subtitle: { template: "modern-outline", position: "bottom" },
    tracks: {
      tts: [
        {
          id: "tts-001",
          text: "Test segment",
          estimatedDuration: 3.0,
          start: 0,
          asset: null,
          status: "confirmed",
        },
      ],
      visual: [
        {
          id: "vis-001",
          layer: 0,
          type: "broll",
          prompt: "test visual",
          linkedTts: ["tts-001"],
          asset: "/tmp/test.mp4",
          status: "confirmed",
        },
      ],
      subtitle: { asset: null, status: "pending" },
    },
  };
}

describe("TTSProvider", () => {
  function createMockTTS(): TTSProvider {
    const voices: Voice[] = [
      { id: "v1", name: "Xiaoxiao", language: "zh-CN" },
      { id: "v2", name: "Jenny", language: "en-US" },
    ];

    return {
      name: "mock-tts",
      async generate(text: string, voice: VoiceConfig): Promise<AudioAsset> {
        return {
          path: `/tmp/audio-${voice.voiceId}.mp3`,
          duration: text.length * 0.1,
          format: "mp3",
        };
      },
      estimateDuration(text: string): number {
        return text.length * 0.1;
      },
      async listVoices(): Promise<Voice[]> {
        return voices;
      },
    };
  }

  it("should generate audio from text", async () => {
    const tts = createMockTTS();
    const config: VoiceConfig = { voiceId: "v1", speed: 1.0 };
    const result = await tts.generate("Hello world", config);

    expect(result.path).toContain("v1");
    expect(result.duration).toBeGreaterThan(0);
    expect(result.format).toBe("mp3");
  });

  it("should estimate duration synchronously", () => {
    const tts = createMockTTS();
    const duration = tts.estimateDuration("Test text");
    expect(duration).toBeCloseTo(0.9, 1);
  });

  it("should list available voices", async () => {
    const tts = createMockTTS();
    const voices = await tts.listVoices();

    expect(voices).toHaveLength(2);
    expect(voices[0]).toEqual({
      id: "v1",
      name: "Xiaoxiao",
      language: "zh-CN",
    });
  });

  it("should respect voice config options", async () => {
    const tts = createMockTTS();
    const config: VoiceConfig = { voiceId: "v2", speed: 1.5, pitch: 0.8 };
    const result = await tts.generate("Speed test", config);

    expect(result.path).toContain("v2");
  });

  it("should have a name", () => {
    const tts = createMockTTS();
    expect(tts.name).toBe("mock-tts");
  });
});

describe("VideoProvider", () => {
  function createMockVideo(): VideoProvider {
    return {
      name: "mock-video",
      async generate(prompt: string, config: VideoConfig): Promise<VideoAsset> {
        return {
          path: `/tmp/video-${config.aspectRatio.replace(":", "x")}.mp4`,
          duration: config.duration,
          format: "mp4",
        };
      },
      supportedRatios(): AspectRatio[] {
        return ["16:9", "9:16", "1:1"];
      },
    };
  }

  it("should generate video from prompt", async () => {
    const video = createMockVideo();
    const config: VideoConfig = { aspectRatio: "16:9", duration: 5 };
    const result = await video.generate("A sunset over the ocean", config);

    expect(result.path).toContain("16x9");
    expect(result.duration).toBe(5);
    expect(result.format).toBe("mp4");
  });

  it("should generate video with style option", async () => {
    const video = createMockVideo();
    const config: VideoConfig = {
      aspectRatio: "9:16",
      duration: 10,
      style: "cinematic",
    };
    const result = await video.generate("City at night", config);

    expect(result.path).toContain("9x16");
    expect(result.duration).toBe(10);
  });

  it("should return supported aspect ratios", () => {
    const video = createMockVideo();
    const ratios = video.supportedRatios();

    expect(ratios).toContain("16:9");
    expect(ratios).toContain("9:16");
    expect(ratios).toContain("1:1");
    expect(ratios).not.toContain("4:3");
  });

  it("should have a name", () => {
    const video = createMockVideo();
    expect(video.name).toBe("mock-video");
  });
});

describe("CompositorProvider", () => {
  function createMockCompositor(): CompositorProvider {
    return {
      name: "mock-compositor",
      async compose(timeline: Timeline, assets: AssetMap): Promise<VideoFile> {
        const totalDuration = timeline.tracks.tts.reduce(
          (sum, s) => sum + s.estimatedDuration,
          0,
        );
        return {
          path: `/tmp/output-${timeline.contentId}.mp4`,
          duration: totalDuration,
          format: "mp4",
        };
      },
      async export(
        timeline: Timeline,
        assets: AssetMap,
        format: ExportFormat,
      ): Promise<ProjectFile> {
        return {
          path: `/tmp/project-${timeline.contentId}.${format}`,
          format,
        };
      },
      supportedFormats(): ExportFormat[] {
        return ["jianying", "davinci", "fcpx"];
      },
    };
  }

  it("should compose timeline into video file", async () => {
    const compositor = createMockCompositor();
    const timeline = makeTimeline();
    const assets: AssetMap = { a1: "/tmp/clip1.mp4" };

    const result = await compositor.compose(timeline, assets);

    expect(result.path).toContain("test-123");
    expect(result.duration).toBe(3);
    expect(result.format).toBe("mp4");
  });

  it("should export timeline to project format", async () => {
    const compositor = createMockCompositor();
    const timeline = makeTimeline();
    const assets: AssetMap = { a1: "/tmp/clip1.mp4" };

    const result = await compositor.export(timeline, assets, "jianying");

    expect(result.path).toContain("jianying");
    expect(result.format).toBe("jianying");
  });

  it("should export to all supported formats", async () => {
    const compositor = createMockCompositor();
    const timeline = makeTimeline();
    const assets: AssetMap = {};
    const formats = compositor.supportedFormats();

    for (const fmt of formats) {
      const result = await compositor.export(timeline, assets, fmt);
      expect(result.format).toBe(fmt);
    }
  });

  it("should return supported export formats", () => {
    const compositor = createMockCompositor();
    const formats = compositor.supportedFormats();

    expect(formats).toEqual(["jianying", "davinci", "fcpx"]);
  });

  it("should have a name", () => {
    const compositor = createMockCompositor();
    expect(compositor.name).toBe("mock-compositor");
  });
});
