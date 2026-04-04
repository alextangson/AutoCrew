import { join } from "node:path";
import { mkdir } from "node:fs/promises";

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
  template?: string;
  data?: Record<string, unknown>;
  linkedTts: string[];
  asset: string | null;
  status: string;
  [key: string]: unknown;
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

export interface RenderOptions {
  timeline: Timeline;
  outputDir: string;
  tts: {
    generate(
      text: string,
      voice: { voiceId: string },
      outputPath: string,
    ): Promise<{ path: string; duration: number; format: string }>;
  };
  screenshot: {
    capture(
      html: string,
      viewport: { width: number; height: number },
      outputPath: string,
    ): Promise<{ path: string }>;
  };
  exporter: {
    export(
      timeline: Timeline,
      outputDir: string,
    ): Promise<{ path: string; format: string }>;
  };
  voice: { voiceId: string };
  renderCard?: (
    template: string,
    data: Record<string, unknown>,
    options?: { aspectRatio?: string },
  ) => string;
}

const DIMENSIONS: Record<string, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
};

export async function renderTimeline(
  opts: RenderOptions,
): Promise<{ path: string; format: string }> {
  const { timeline, outputDir, tts, screenshot, exporter, voice } = opts;

  const assetsDir = join(outputDir, "assets");
  await mkdir(assetsDir, { recursive: true });

  // 1. Generate TTS audio (parallel)
  const ttsPromises = timeline.tracks.tts
    .filter((seg) => seg.status === "confirmed" && !seg.asset)
    .map(async (seg) => {
      const outPath = join(assetsDir, `${seg.id}.mp3`);
      const result = await tts.generate(seg.text, voice, outPath);
      seg.asset = result.path;
      seg.estimatedDuration = result.duration;
    });

  await Promise.all(ttsPromises);

  // 2. Screenshot card visuals (parallel)
  const dim = DIMENSIONS[timeline.aspectRatio] ?? DIMENSIONS["9:16"];
  const cardPromises = timeline.tracks.visual
    .filter(
      (vis) =>
        vis.type === "card" &&
        vis.status === "confirmed" &&
        !vis.asset &&
        vis.template &&
        vis.data,
    )
    .map(async (vis) => {
      const outPath = join(assetsDir, `${vis.id}.png`);
      const html = opts.renderCard
        ? opts.renderCard(vis.template!, vis.data!, {
            aspectRatio: timeline.aspectRatio,
          })
        : `<html><body><h1>${vis.template}</h1><pre>${JSON.stringify(vis.data)}</pre></body></html>`;
      const result = await screenshot.capture(html, dim, outPath);
      vis.asset = result.path;
    });

  await Promise.all(cardPromises);

  // 3. Export
  return exporter.export(timeline, join(outputDir, "draft"));
}
