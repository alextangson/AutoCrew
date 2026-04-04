export interface TimeRange {
  start: number; // microseconds
  duration: number; // microseconds
}

export interface CanvasConfig {
  width: number;
  height: number;
  ratio: string;
}

export interface DraftContent {
  canvas_config: CanvasConfig;
  duration: number;
  fps: number;
  id: string;
  name: string;
  version: number;
  platform: {
    app_id: number;
    app_source: string;
    app_version: string;
    os: string;
  };
  materials: {
    videos: Record<string, unknown>[];
    audios: Record<string, unknown>[];
    texts: Record<string, unknown>[];
    [key: string]: unknown[];
  };
  tracks: Record<string, unknown>[];
  keyframes: Record<string, unknown[]>;
  [key: string]: unknown;
}
