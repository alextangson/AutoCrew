export interface TTSSegment {
  id: string;
  text: string;
  estimatedDuration: number;
  start: number;
  asset: string | null;
  status: string;
}

export interface VisualSegment {
  id: string;
  layer: number;
  type: "broll" | "card";
  prompt?: string;
  template?: string;
  data?: Record<string, unknown>;
  linkedTts: string[];
  opacity?: number;
  asset: string | null;
  status: string;
}

export interface Timeline {
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
