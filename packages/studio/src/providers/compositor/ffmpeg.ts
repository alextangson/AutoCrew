import ffmpeg from "fluent-ffmpeg";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface MediaSegment {
  path: string;
  startSec: number;
  durationSec: number;
}

export interface ComposeInput {
  audioSegments: MediaSegment[];
  videoSegments: MediaSegment[];
  imageSegments: MediaSegment[];
  canvas: { width: number; height: number };
}

export interface ComposeResult {
  path: string;
  format: "mp4";
  duration: number;
}

export class FFmpegCompositor {
  // TODO: Use complexFilter to position segments at their startSec offsets.
  // Currently all inputs start at t=0, ignoring startSec values.
  async compose(input: ComposeInput, outputPath: string): Promise<ComposeResult> {
    await mkdir(dirname(outputPath), { recursive: true });

    const allSegments = [
      ...input.audioSegments,
      ...input.videoSegments,
      ...input.imageSegments,
    ];

    const totalDuration = allSegments.length > 0
      ? Math.max(...allSegments.map((s) => s.startSec + s.durationSec))
      : 0;

    if (totalDuration === 0) {
      return { path: outputPath, format: "mp4", duration: 0 };
    }

    return new Promise((resolve, reject) => {
      let cmd = ffmpeg();

      for (const seg of [...input.videoSegments, ...input.imageSegments]) {
        cmd = cmd.input(seg.path);
      }

      for (const seg of input.audioSegments) {
        cmd = cmd.input(seg.path);
      }

      cmd
        .outputOptions([
          `-s ${input.canvas.width}x${input.canvas.height}`,
          "-c:v libx264",
          "-c:a aac",
          "-pix_fmt yuv420p",
          "-shortest",
        ])
        .output(outputPath)
        .on("end", () => resolve({ path: outputPath, format: "mp4", duration: totalDuration }))
        .on("error", (err: Error) => reject(err))
        .run();
    });
  }
}
