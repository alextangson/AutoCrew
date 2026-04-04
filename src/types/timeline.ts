export type VideoPreset = "knowledge-explainer" | "tutorial";
export type AspectRatio = "9:16" | "16:9" | "3:4" | "1:1" | "4:3";
export type SubtitleTemplate =
  | "modern-outline"
  | "karaoke-highlight"
  | "minimal-fade"
  | "bold-top";
export type SubtitlePosition = "bottom" | "top";
export type SegmentStatus =
  | "pending"
  | "generating"
  | "ready"
  | "confirmed"
  | "failed";
export type VisualType = "broll" | "card";
export type CardTemplate =
  | "comparison-table"
  | "key-points"
  | "flow-chart"
  | "data-chart";

export interface TTSSegment {
  id: string;
  text: string;
  estimatedDuration: number;
  start: number;
  asset: string | null;
  status: SegmentStatus;
}

export interface VisualSegment {
  id: string;
  layer: number;
  type: VisualType;
  prompt?: string;
  template?: CardTemplate;
  data?: Record<string, unknown>;
  linkedTts: string[];
  opacity?: number;
  asset: string | null;
  status: SegmentStatus;
}

export interface SubtitleTrack {
  asset: string | null;
  status: SegmentStatus;
}

export interface SubtitleConfig {
  template: SubtitleTemplate;
  position: SubtitlePosition;
}

export interface Timeline {
  version: "2.0";
  contentId: string;
  preset: VideoPreset;
  aspectRatio: AspectRatio;
  subtitle: SubtitleConfig;
  tracks: {
    tts: TTSSegment[];
    visual: VisualSegment[];
    subtitle: SubtitleTrack;
  };
}
