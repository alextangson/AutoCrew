// packages/studio/tests/integration.test.ts
import { describe, it, expect } from "vitest";
import { DoubaoTTS } from "../src/providers/tts/doubao.js";
import { PuppeteerScreenshot } from "../src/providers/screenshot/puppeteer.js";
import { JianyingExporter } from "../src/providers/compositor/jianying/exporter.js";
import { DraftBuilder } from "../src/providers/compositor/jianying/draft.js";
import { renderTimeline } from "../src/pipeline/render.js";
import { loadConfig } from "../src/config/index.js";

describe("@autocrew/studio integration", () => {
  it("all exports are importable", () => {
    expect(DoubaoTTS).toBeDefined();
    expect(PuppeteerScreenshot).toBeDefined();
    expect(JianyingExporter).toBeDefined();
    expect(DraftBuilder).toBeDefined();
    expect(renderTimeline).toBeDefined();
    expect(loadConfig).toBeDefined();
  });

  it("DraftBuilder produces valid Jianying JSON structure", () => {
    const builder = new DraftBuilder("Smoke Test", { width: 1080, height: 1920 });
    builder
      .addAudio({ path: "/tmp/a.mp3", startUs: 0, durationUs: 3_000_000 })
      .addImage({ path: "/tmp/card.png", startUs: 0, durationUs: 3_000_000, width: 1080, height: 1920 })
      .addSubtitle({ text: "测试字幕", startUs: 0, durationUs: 3_000_000 });

    const draft = builder.build();

    // Verify Jianying format requirements
    expect(draft.version).toBe(360000);
    expect(draft.fps).toBe(30);
    expect(draft.canvas_config.width).toBe(1080);
    expect(draft.duration).toBe(3_000_000);
    expect(draft.tracks.length).toBe(3); // image + audio + subtitle
    expect(draft.materials.audios.length).toBe(1);
    expect(draft.materials.videos.length).toBe(1);
    expect(draft.materials.texts.length).toBe(1);

    // Verify JSON serializable
    const json = JSON.stringify(draft);
    expect(json).toBeDefined();
    const parsed = JSON.parse(json);
    expect(parsed.canvas_config.width).toBe(1080);
  });
});
