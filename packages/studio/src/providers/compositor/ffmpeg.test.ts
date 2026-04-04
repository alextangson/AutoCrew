import { describe, it, expect, vi } from "vitest";
import { FFmpegCompositor } from "./ffmpeg.js";

vi.mock("fluent-ffmpeg", () => {
  const instance = {
    input: vi.fn().mockReturnThis(),
    complexFilter: vi.fn().mockReturnThis(),
    outputOptions: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    on: vi.fn(function (this: Record<string, unknown>, event: string, cb: () => void) {
      if (event === "end") setTimeout(cb, 0);
      return this;
    }),
    run: vi.fn(),
  };
  return { default: vi.fn(() => instance) };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe("FFmpegCompositor", () => {
  it("composes timeline assets into mp4", async () => {
    const compositor = new FFmpegCompositor();
    const result = await compositor.compose(
      {
        audioSegments: [{ path: "/tmp/tts.mp3", startSec: 0, durationSec: 3 }],
        videoSegments: [{ path: "/tmp/clip.mp4", startSec: 0, durationSec: 3 }],
        imageSegments: [],
        canvas: { width: 1080, height: 1920 },
      },
      "/tmp/output.mp4"
    );

    expect(result.path).toBe("/tmp/output.mp4");
    expect(result.format).toBe("mp4");
    expect(result.duration).toBe(3);
  });

  it("handles empty segments", async () => {
    const compositor = new FFmpegCompositor();
    const result = await compositor.compose(
      {
        audioSegments: [],
        videoSegments: [],
        imageSegments: [],
        canvas: { width: 1080, height: 1920 },
      },
      "/tmp/empty.mp4"
    );

    expect(result.duration).toBe(0);
  });
});
