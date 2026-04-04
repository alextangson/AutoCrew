import { randomUUID } from "node:crypto";
import type { DraftContent, TimeRange } from "./types.js";

function uuid(): string {
  return randomUUID().replace(/-/g, "").toUpperCase();
}

function timerange(startUs: number, durationUs: number): TimeRange {
  return { start: startUs, duration: durationUs };
}

export interface AddVideoOpts {
  path: string;
  startUs: number;
  durationUs: number;
  width: number;
  height: number;
}

export interface AddAudioOpts {
  path: string;
  startUs: number;
  durationUs: number;
}

export interface AddImageOpts {
  path: string;
  startUs: number;
  durationUs: number;
  width: number;
  height: number;
}

export interface AddSubtitleOpts {
  text: string;
  startUs: number;
  durationUs: number;
  fontSize?: number;
  color?: [number, number, number];
}

interface InternalTrack {
  id: string;
  type: "video" | "audio" | "text";
  segments: Record<string, unknown>[];
}

export class DraftBuilder {
  private projectName: string;
  private canvas: { width: number; height: number };
  private videoTrack: InternalTrack | null = null;
  private audioTrack: InternalTrack | null = null;
  private imageTrack: InternalTrack | null = null;
  private subtitleTrack: InternalTrack | null = null;
  private materials: {
    videos: Record<string, unknown>[];
    audios: Record<string, unknown>[];
    texts: Record<string, unknown>[];
  } = { videos: [], audios: [], texts: [] };
  private maxEnd = 0;

  constructor(name: string, canvas: { width: number; height: number }) {
    this.projectName = name;
    this.canvas = canvas;
  }

  addVideo(opts: AddVideoOpts): this {
    if (!this.videoTrack) {
      this.videoTrack = { id: uuid(), type: "video", segments: [] };
    }
    const matId = uuid();
    this.materials.videos.push({
      id: matId,
      path: opts.path,
      duration: opts.durationUs,
      width: opts.width,
      height: opts.height,
      type: "video",
    });
    this.videoTrack.segments.push({
      id: uuid(),
      material_id: matId,
      target_timerange: timerange(opts.startUs, opts.durationUs),
      source_timerange: timerange(0, opts.durationUs),
      visible: true,
    });
    this.updateMaxEnd(opts.startUs + opts.durationUs);
    return this;
  }

  addAudio(opts: AddAudioOpts): this {
    if (!this.audioTrack) {
      this.audioTrack = { id: uuid(), type: "audio", segments: [] };
    }
    const matId = uuid();
    this.materials.audios.push({
      id: matId,
      path: opts.path,
      duration: opts.durationUs,
      type: "audio",
    });
    this.audioTrack.segments.push({
      id: uuid(),
      material_id: matId,
      target_timerange: timerange(opts.startUs, opts.durationUs),
      source_timerange: timerange(0, opts.durationUs),
      visible: true,
    });
    this.updateMaxEnd(opts.startUs + opts.durationUs);
    return this;
  }

  addImage(opts: AddImageOpts): this {
    if (!this.imageTrack) {
      this.imageTrack = { id: uuid(), type: "video", segments: [] };
    }
    const matId = uuid();
    this.materials.videos.push({
      id: matId,
      path: opts.path,
      duration: opts.durationUs,
      width: opts.width,
      height: opts.height,
      type: "photo",
    });
    this.imageTrack.segments.push({
      id: uuid(),
      material_id: matId,
      target_timerange: timerange(opts.startUs, opts.durationUs),
      source_timerange: timerange(0, opts.durationUs),
      visible: true,
    });
    this.updateMaxEnd(opts.startUs + opts.durationUs);
    return this;
  }

  addSubtitle(opts: AddSubtitleOpts): this {
    if (!this.subtitleTrack) {
      this.subtitleTrack = { id: uuid(), type: "text", segments: [] };
    }
    const matId = uuid();
    const fontSize = opts.fontSize ?? 8.0;
    const color = opts.color ?? [1, 1, 1];
    this.materials.texts.push({
      id: matId,
      type: "text",
      content: JSON.stringify({
        text: opts.text,
        styles: [
          {
            range: [0, opts.text.length],
            size: fontSize,
            bold: false,
            color,
          },
        ],
      }),
      alignment: 1,
      font_size: fontSize,
      global_alpha: 1.0,
    });
    this.subtitleTrack.segments.push({
      id: uuid(),
      material_id: matId,
      target_timerange: timerange(opts.startUs, opts.durationUs),
      source_timerange: timerange(0, opts.durationUs),
      visible: true,
    });
    this.updateMaxEnd(opts.startUs + opts.durationUs);
    return this;
  }

  build(): DraftContent {
    const tracks: Record<string, unknown>[] = [];
    if (this.videoTrack) tracks.push(this.videoTrack);
    if (this.imageTrack) tracks.push(this.imageTrack);
    if (this.audioTrack) tracks.push(this.audioTrack);
    if (this.subtitleTrack) tracks.push(this.subtitleTrack);

    return {
      canvas_config: {
        width: this.canvas.width,
        height: this.canvas.height,
        ratio: "original",
      },
      duration: this.maxEnd,
      fps: 30,
      id: uuid(),
      name: this.projectName,
      version: 360000,
      platform: {
        app_id: 3704,
        app_source: "lv",
        app_version: "5.9.0",
        os: "mac",
      },
      materials: {
        videos: this.materials.videos,
        audios: this.materials.audios,
        texts: this.materials.texts,
      },
      tracks,
      keyframes: {
        videos: [],
        audios: [],
        texts: [],
        effects: [],
        filters: [],
        adjusts: [],
        stickers: [],
        handwrites: [],
      },
    };
  }

  private updateMaxEnd(end: number): void {
    if (end > this.maxEnd) this.maxEnd = end;
  }
}
