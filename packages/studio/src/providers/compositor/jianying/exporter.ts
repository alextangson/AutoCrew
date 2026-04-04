import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DraftBuilder } from "./draft.js";
import type { DraftContent } from "./types.js";

// Use inline types to avoid cross-package dependency for now
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

const DIMENSIONS: Record<string, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
};

function secToUs(sec: number): number {
  return Math.round(sec * 1_000_000);
}

export interface ExportResult {
  path: string;
  format: "jianying";
}

export class JianyingExporter {
  timelineToDraft(timeline: Timeline): DraftContent {
    const dim = DIMENSIONS[timeline.aspectRatio] ?? DIMENSIONS["9:16"];
    const builder = new DraftBuilder(`AutoCrew-${timeline.contentId}`, dim);

    const ttsMap = new Map<string, TTSSegment>();
    for (const seg of timeline.tracks.tts) {
      ttsMap.set(seg.id, seg);
    }

    // Add TTS as audio segments
    for (const seg of timeline.tracks.tts) {
      if (seg.status !== "confirmed" || !seg.asset) continue;
      builder.addAudio({
        path: seg.asset,
        startUs: secToUs(seg.start),
        durationUs: secToUs(seg.estimatedDuration),
      });
    }

    // Add subtitles from TTS text
    for (const seg of timeline.tracks.tts) {
      if (seg.status !== "confirmed") continue;
      builder.addSubtitle({
        text: seg.text,
        startUs: secToUs(seg.start),
        durationUs: secToUs(seg.estimatedDuration),
      });
    }

    // Add visuals
    for (const vis of timeline.tracks.visual) {
      if (vis.status !== "confirmed" || !vis.asset) continue;

      const linkedSegs = vis.linkedTts
        .map((id) => ttsMap.get(id))
        .filter((s): s is TTSSegment => s !== undefined);

      if (linkedSegs.length === 0) continue;

      const start = Math.min(...linkedSegs.map((s) => s.start));
      const end = Math.max(
        ...linkedSegs.map((s) => s.start + s.estimatedDuration),
      );
      const duration = end - start;

      if (vis.type === "card") {
        builder.addImage({
          path: vis.asset,
          startUs: secToUs(start),
          durationUs: secToUs(duration),
          width: dim.width,
          height: dim.height,
        });
      } else {
        builder.addVideo({
          path: vis.asset,
          startUs: secToUs(start),
          durationUs: secToUs(duration),
          width: dim.width,
          height: dim.height,
        });
      }
    }

    return builder.build();
  }

  async export(timeline: Timeline, outputDir: string): Promise<ExportResult> {
    const draft = this.timelineToDraft(timeline);

    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, "draft_content.json"),
      JSON.stringify(draft, null, 2),
      "utf-8",
    );

    return { path: outputDir, format: "jianying" };
  }
}
