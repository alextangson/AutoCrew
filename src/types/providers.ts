import type { AspectRatio, Timeline } from "./timeline.js";

export interface Voice {
  id: string;
  name: string;
  language: string;
}

export interface VoiceConfig {
  voiceId: string;
  speed?: number;
  pitch?: number;
}

export interface AudioAsset {
  path: string;
  duration: number;
  format: "mp3" | "wav" | "ogg";
}

export interface VideoConfig {
  aspectRatio: AspectRatio;
  duration: number;
  style?: string;
}

export interface VideoAsset {
  path: string;
  duration: number;
  format: "mp4" | "webm" | "mov";
}

export interface VideoFile {
  path: string;
  duration: number;
  format: string;
}

export interface ProjectFile {
  path: string;
  format: ExportFormat;
}

export type ExportFormat = "jianying" | "davinci" | "fcpx";
export type AssetMap = Record<string, string>;

export interface TTSProvider {
  name: string;
  generate(text: string, voice: VoiceConfig): Promise<AudioAsset>;
  estimateDuration(text: string): number;
  listVoices(): Promise<Voice[]>;
}

export interface VideoProvider {
  name: string;
  generate(prompt: string, config: VideoConfig): Promise<VideoAsset>;
  supportedRatios(): AspectRatio[];
}

export interface CompositorProvider {
  name: string;
  compose(timeline: Timeline, assets: AssetMap): Promise<VideoFile>;
  export(
    timeline: Timeline,
    assets: AssetMap,
    format: ExportFormat,
  ): Promise<ProjectFile>;
  supportedFormats(): ExportFormat[];
}
