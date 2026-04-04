// packages/studio/src/index.ts
export { DoubaoTTS } from "./providers/tts/doubao.js";
export type { Voice, VoiceConfig, AudioAsset } from "./providers/tts/doubao.js";

export { PuppeteerScreenshot } from "./providers/screenshot/puppeteer.js";
export type { ScreenshotResult, Viewport } from "./providers/screenshot/puppeteer.js";

export { FFmpegCompositor } from "./providers/compositor/ffmpeg.js";
export type { ComposeInput, ComposeResult, MediaSegment } from "./providers/compositor/ffmpeg.js";

export { DraftBuilder } from "./providers/compositor/jianying/draft.js";
export { JianyingExporter } from "./providers/compositor/jianying/exporter.js";
export type { ExportResult } from "./providers/compositor/jianying/exporter.js";

export { renderTimeline } from "./pipeline/render.js";
export type { RenderOptions } from "./pipeline/render.js";

export { loadConfig } from "./config/index.js";
export type { StudioConfig, DoubaoConfig, JianyingConfig } from "./config/index.js";
