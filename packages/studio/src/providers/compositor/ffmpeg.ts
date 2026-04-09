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

/**
 * Build a complex filter graph that:
 * 1. Creates a blank canvas as the base video
 * 2. Overlays each image/video at its correct startSec offset
 * 3. Delays each audio segment to its startSec offset
 * 4. Mixes all audio into one stream
 */
function buildFilterGraph(
  input: ComposeInput,
  totalDuration: number,
): { filters: string[]; inputs: string[]; videoOut: string; audioOut: string } {
  const { canvas } = input;
  const filters: string[] = [];
  const inputs: string[] = [];

  // Base: blank canvas for the full duration
  filters.push(
    `color=c=black:s=${canvas.width}x${canvas.height}:d=${totalDuration}:r=30[base]`,
  );

  let currentVideo = "base";
  let inputIdx = 0;

  // Overlay video segments at their time offsets
  for (const seg of input.videoSegments) {
    const inLabel = `${inputIdx}:v`;
    const outLabel = `v${inputIdx}`;
    inputs.push(seg.path);

    // Scale to canvas, set duration, overlay at startSec
    filters.push(
      `[${inLabel}]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,` +
      `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,` +
      `setpts=PTS+${seg.startSec}/TB[scaled${inputIdx}]`,
    );
    filters.push(
      `[${currentVideo}][scaled${inputIdx}]overlay=enable='between(t,${seg.startSec},${seg.startSec + seg.durationSec})'[${outLabel}]`,
    );
    currentVideo = outLabel;
    inputIdx++;
  }

  // Overlay image segments (as still frames with duration)
  for (const seg of input.imageSegments) {
    const inLabel = `${inputIdx}:v`;
    const outLabel = `img${inputIdx}`;
    inputs.push(seg.path);

    // Loop image for its duration, scale and overlay
    filters.push(
      `[${inLabel}]loop=loop=${Math.ceil(seg.durationSec * 30)}:size=1:start=0,` +
      `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,` +
      `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,` +
      `setpts=PTS+${seg.startSec}/TB[imgscaled${inputIdx}]`,
    );
    filters.push(
      `[${currentVideo}][imgscaled${inputIdx}]overlay=enable='between(t,${seg.startSec},${seg.startSec + seg.durationSec})'[${outLabel}]`,
    );
    currentVideo = outLabel;
    inputIdx++;
  }

  // Audio: delay each segment and mix
  const audioLabels: string[] = [];
  for (const seg of input.audioSegments) {
    const aLabel = `a${inputIdx}`;
    inputs.push(seg.path);

    // Delay audio to its startSec offset (delay is in milliseconds)
    const delayMs = Math.round(seg.startSec * 1000);
    filters.push(
      `[${inputIdx}:a]adelay=${delayMs}|${delayMs}[${aLabel}]`,
    );
    audioLabels.push(`[${aLabel}]`);
    inputIdx++;
  }

  // Mix all audio streams (or create silence if none)
  let audioOut: string;
  if (audioLabels.length > 0) {
    audioOut = "amixed";
    filters.push(
      `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest[${audioOut}]`,
    );
  } else {
    audioOut = "silence";
    filters.push(`anullsrc=r=44100:cl=stereo:d=${totalDuration}[${audioOut}]`);
  }

  return { filters, inputs, videoOut: currentVideo, audioOut };
}

export class FFmpegCompositor {
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

    const { filters, inputs, videoOut, audioOut } = buildFilterGraph(input, totalDuration);

    return new Promise((resolve, reject) => {
      let cmd = ffmpeg();

      for (const inputPath of inputs) {
        cmd = cmd.input(inputPath);
      }

      cmd
        .complexFilter(filters, [videoOut, audioOut])
        .outputOptions([
          "-c:v libx264",
          "-c:a aac",
          "-pix_fmt yuv420p",
          "-movflags +faststart",
        ])
        .output(outputPath)
        .on("end", () => resolve({ path: outputPath, format: "mp4", duration: totalDuration }))
        .on("error", (err: Error) => reject(err))
        .run();
    });
  }
}
