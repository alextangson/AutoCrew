import { describe, it, expect } from "vitest";
import { DraftBuilder } from "./draft.js";

describe("DraftBuilder", () => {
  it("creates a minimal draft structure", () => {
    const builder = new DraftBuilder("Test Project", {
      width: 1080,
      height: 1920,
    });
    const draft = builder.build();

    expect(draft.canvas_config.width).toBe(1080);
    expect(draft.canvas_config.height).toBe(1920);
    expect(draft.fps).toBe(30);
    expect(draft.version).toBe(360000);
    expect(draft.tracks).toEqual([]);
  });

  it("adds a video segment", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addVideo({
      path: "/tmp/clip.mp4",
      startUs: 0,
      durationUs: 5_000_000,
      width: 1080,
      height: 1920,
    });
    const draft = builder.build();

    expect(draft.tracks.length).toBe(1);
    expect(draft.materials.videos.length).toBe(1);
    expect((draft.materials.videos[0] as { path: string }).path).toBe(
      "/tmp/clip.mp4",
    );
  });

  it("adds an audio segment", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addAudio({
      path: "/tmp/tts.mp3",
      startUs: 0,
      durationUs: 3_200_000,
    });
    const draft = builder.build();

    expect(draft.tracks.length).toBe(1);
    const track = draft.tracks[0] as { type: string };
    expect(track.type).toBe("audio");
  });

  it("adds an image segment (for card screenshots)", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addImage({
      path: "/tmp/card.png",
      startUs: 0,
      durationUs: 3_000_000,
      width: 1080,
      height: 1920,
    });
    const draft = builder.build();

    expect(draft.tracks.length).toBe(1);
    expect(draft.materials.videos.length).toBe(1); // images go in videos array in Jianying
  });

  it("adds subtitle text segments", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addSubtitle({
      text: "\u4f60\u597d\u4e16\u754c",
      startUs: 0,
      durationUs: 2_000_000,
    });
    const draft = builder.build();

    expect(draft.tracks.length).toBe(1);
    expect(draft.materials.texts.length).toBe(1);
  });

  it("calculates total duration from all segments", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addAudio({ path: "/a.mp3", startUs: 0, durationUs: 3_000_000 });
    builder.addAudio({
      path: "/b.mp3",
      startUs: 3_000_000,
      durationUs: 2_000_000,
    });
    const draft = builder.build();

    expect(draft.duration).toBe(5_000_000);
  });
});
