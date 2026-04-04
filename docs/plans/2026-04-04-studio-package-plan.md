# @autocrew/studio Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the @autocrew/studio package with Doubao TTS, Puppeteer card screenshots, FFmpeg composition, and Jianying project export.

**Architecture:** npm workspaces monorepo. Studio is a separate package under packages/studio/ that depends on core's type definitions and card template engine. Providers implement the interfaces defined in src/types/providers.ts.

**Tech Stack:** TypeScript, Vitest, fluent-ffmpeg, puppeteer, Hono (config server if needed)

---

### Task 1: Workspace Root Setup

**Files:**
- Modify: `package.json` (root)
- Create: `packages/studio/package.json`
- Create: `packages/studio/vitest.config.ts`
- Create: `packages/studio/tsconfig.json`

**Step 1: Add workspaces to root package.json**

Add `"workspaces"` field to existing root `package.json`:

```json
{
  "workspaces": ["packages/*"]
}
```

Keep all existing fields. Only add `workspaces`.

**Step 2: Create packages/studio/package.json**

```json
{
  "name": "@autocrew/studio",
  "version": "0.1.0",
  "description": "Video production studio for AutoCrew — TTS, screenshots, composition, and Jianying export.",
  "type": "module",
  "license": "MIT",
  "main": "src/index.ts",
  "dependencies": {
    "fluent-ffmpeg": "^2.1.3",
    "puppeteer": "^24.0.0"
  },
  "devDependencies": {
    "@types/fluent-ffmpeg": "^2.1.27",
    "vitest": "^4.1.2"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 3: Create packages/studio/vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
```

**Step 4: Create packages/studio/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src"]
}
```

**Step 5: Install dependencies**

Run: `cd /Users/jiaxintang/AutoCrew && npm install`

Verify workspaces are linked: `npm ls --workspaces`

**Step 6: Commit**

```bash
git add package.json packages/studio/package.json packages/studio/vitest.config.ts packages/studio/tsconfig.json
git commit -m "chore: scaffold @autocrew/studio workspace package"
```

---

### Task 2: Studio Config System

**Files:**
- Create: `packages/studio/src/config/index.ts`
- Create: `packages/studio/src/config/index.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/studio/src/config/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig, type StudioConfig } from "./index.js";
import { readFile } from "node:fs/promises";

vi.mock("node:fs/promises");

describe("loadConfig", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads config from file", async () => {
    const cfg: StudioConfig = {
      tts: {
        provider: "doubao",
        doubao: { appId: "app1", accessToken: "tok1", voiceType: "BV700_V2_streaming" },
      },
      screenshot: { provider: "puppeteer" },
      compositor: { provider: "jianying", jianying: { draftDir: "/tmp/drafts" } },
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(cfg));
    const result = await loadConfig("/fake/.autocrew");
    expect(result.tts.provider).toBe("doubao");
    expect(result.tts.doubao?.appId).toBe("app1");
  });

  it("returns defaults when file missing", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
    const result = await loadConfig("/fake/.autocrew");
    expect(result.tts.provider).toBe("doubao");
    expect(result.compositor.provider).toBe("jianying");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/config/index.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// packages/studio/src/config/index.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DoubaoConfig {
  appId: string;
  accessToken: string;
  voiceType: string;
  cluster?: string;
}

export interface JianyingConfig {
  draftDir: string;
}

export interface StudioConfig {
  tts: {
    provider: "doubao";
    doubao?: DoubaoConfig;
  };
  screenshot: {
    provider: "puppeteer";
  };
  compositor: {
    provider: "ffmpeg" | "jianying";
    jianying?: JianyingConfig;
  };
}

const defaults: StudioConfig = {
  tts: { provider: "doubao" },
  screenshot: { provider: "puppeteer" },
  compositor: { provider: "jianying" },
};

export async function loadConfig(dataDir: string): Promise<StudioConfig> {
  try {
    const raw = await readFile(join(dataDir, "studio.config.json"), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StudioConfig>;
    return { ...defaults, ...parsed };
  } catch {
    return { ...defaults };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/config/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/studio/src/config/
git commit -m "feat(studio): add config loader with defaults"
```

---

### Task 3: Doubao TTS Provider

**Files:**
- Create: `packages/studio/src/providers/tts/doubao.ts`
- Create: `packages/studio/src/providers/tts/doubao.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/studio/src/providers/tts/doubao.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DoubaoTTS } from "./doubao.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("DoubaoTTS", () => {
  let tts: DoubaoTTS;

  beforeEach(() => {
    tts = new DoubaoTTS({
      appId: "test-app",
      accessToken: "test-token",
      voiceType: "BV700_V2_streaming",
    });
    vi.clearAllMocks();
  });

  it("has correct name", () => {
    expect(tts.name).toBe("doubao");
  });

  it("estimates duration for Chinese text", () => {
    // ~4 chars/sec for Chinese
    const duration = tts.estimateDuration("今天我们来聊聊效率工具"); // 10 chars
    expect(duration).toBeCloseTo(2.5, 0);
  });

  it("generates audio from text", async () => {
    // base64 of a tiny valid chunk (simulating mp3 bytes)
    const fakeBase64 = Buffer.from("fake-audio-data").toString("base64");
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 3000, message: "Success", data: fakeBase64 }),
    });

    const result = await tts.generate("你好世界", {
      voiceId: "BV700_V2_streaming",
    }, "/tmp/output.mp3");

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.format).toBe("mp3");

    // Verify request body structure
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.app.appid).toBe("test-app");
    expect(callBody.request.text).toBe("你好世界");
  });

  it("throws on API error", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 4000, message: "Invalid token" }),
    });

    await expect(
      tts.generate("你好", { voiceId: "BV700_V2_streaming" }, "/tmp/out.mp3")
    ).rejects.toThrow("Doubao TTS error 4000: Invalid token");
  });

  it("lists voices", async () => {
    const voices = await tts.listVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toHaveProperty("id");
    expect(voices[0]).toHaveProperty("language", "zh-CN");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/tts/doubao.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// packages/studio/src/providers/tts/doubao.ts
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DoubaoConfig } from "../../config/index.js";

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

const TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v1/tts";

const BUILTIN_VOICES: Voice[] = [
  { id: "BV700_V2_streaming", name: "灿灿 2.0", language: "zh-CN" },
  { id: "BV405_streaming", name: "微晴", language: "zh-CN" },
  { id: "BV406_streaming", name: "梦欣", language: "zh-CN" },
  { id: "BV407_streaming", name: "然月", language: "zh-CN" },
  { id: "BV428_streaming", name: "青青", language: "zh-CN" },
  { id: "BV123_streaming", name: "阳光男声", language: "zh-CN" },
];

export class DoubaoTTS {
  readonly name = "doubao";
  private config: DoubaoConfig;

  constructor(config: DoubaoConfig) {
    this.config = config;
  }

  estimateDuration(text: string): number {
    // Chinese: ~4 chars/sec
    return text.length / 4;
  }

  async generate(text: string, voice: VoiceConfig, outputPath: string): Promise<AudioAsset> {
    const body = {
      app: {
        appid: this.config.appId,
        token: "access_token",
        cluster: this.config.cluster ?? "volcano_tts",
      },
      user: { uid: "autocrew" },
      audio: {
        voice_type: voice.voiceId || this.config.voiceType,
        encoding: "mp3",
        speed_ratio: voice.speed ?? 1.0,
        pitch_ratio: voice.pitch ?? 1.0,
      },
      request: {
        reqid: randomUUID(),
        text,
        operation: "query",
        text_type: "plain",
      },
    };

    const res = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer;${this.config.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json()) as { code: number; message: string; data?: string };

    if (json.code !== 3000 || !json.data) {
      throw new Error(`Doubao TTS error ${json.code}: ${json.message}`);
    }

    const audioBuffer = Buffer.from(json.data, "base64");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, audioBuffer);

    // Rough duration estimate from mp3 file size: ~16kB/sec at 128kbps
    const estimatedDuration = audioBuffer.length / 16000;

    return {
      path: outputPath,
      duration: estimatedDuration,
      format: "mp3",
    };
  }

  async listVoices(): Promise<Voice[]> {
    return BUILTIN_VOICES;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/tts/doubao.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/studio/src/providers/tts/
git commit -m "feat(studio): add Doubao TTS provider"
```

---

### Task 4: Puppeteer Screenshot Provider

**Files:**
- Create: `packages/studio/src/providers/screenshot/puppeteer.ts`
- Create: `packages/studio/src/providers/screenshot/puppeteer.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/studio/src/providers/screenshot/puppeteer.test.ts
import { describe, it, expect, vi } from "vitest";
import { PuppeteerScreenshot } from "./puppeteer.js";

// Don't actually launch a browser in unit tests — mock puppeteer
vi.mock("puppeteer", () => {
  const mockPage = {
    setViewport: vi.fn(),
    setContent: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    close: vi.fn(),
  };
  const mockBrowser = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn(),
  };
  return {
    default: { launch: vi.fn().mockResolvedValue(mockBrowser) },
  };
});

describe("PuppeteerScreenshot", () => {
  it("screenshots HTML to file", async () => {
    const ss = new PuppeteerScreenshot();
    const result = await ss.capture(
      "<html><body><h1>Test</h1></body></html>",
      { width: 1080, height: 1920 },
      "/tmp/card.png"
    );
    expect(result.path).toBe("/tmp/card.png");
    expect(result.format).toBe("png");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/screenshot/puppeteer.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// packages/studio/src/providers/screenshot/puppeteer.ts
import puppeteer from "puppeteer";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
  format: "png";
}

export interface Viewport {
  width: number;
  height: number;
}

export class PuppeteerScreenshot {
  async capture(html: string, viewport: Viewport, outputPath: string): Promise<ScreenshotResult> {
    const browser = await puppeteer.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setViewport(viewport);
      await page.setContent(html, { waitUntil: "networkidle0" });

      await mkdir(dirname(outputPath), { recursive: true });

      const buffer = await page.screenshot({ path: outputPath, type: "png" });
      await page.close();

      return {
        path: outputPath,
        width: viewport.width,
        height: viewport.height,
        format: "png",
      };
    } finally {
      await browser.close();
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/screenshot/puppeteer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/studio/src/providers/screenshot/
git commit -m "feat(studio): add Puppeteer screenshot provider for card images"
```

---

### Task 5: Jianying Draft Builder

**Files:**
- Create: `packages/studio/src/providers/compositor/jianying/types.ts`
- Create: `packages/studio/src/providers/compositor/jianying/draft.ts`
- Create: `packages/studio/src/providers/compositor/jianying/draft.test.ts`

**Step 1: Write Jianying types**

```typescript
// packages/studio/src/providers/compositor/jianying/types.ts

export interface TimeRange {
  start: number;   // microseconds
  duration: number; // microseconds
}

export interface JianyingMaterial {
  id: string;
  type: string;
}

export interface VideoMaterial extends JianyingMaterial {
  type: "video";
  path: string;
  duration: number;
  width: number;
  height: number;
}

export interface AudioMaterial extends JianyingMaterial {
  type: "audio";
  path: string;
  duration: number;
}

export interface ImageMaterial extends JianyingMaterial {
  type: "photo";
  path: string;
  width: number;
  height: number;
}

export interface TextMaterial extends JianyingMaterial {
  type: "text";
  content: string;
  fontSize: number;
  color: [number, number, number]; // RGB 0-1
}

export interface JianyingSegment {
  id: string;
  material_id: string;
  target_timerange: TimeRange;
  source_timerange: TimeRange;
}

export interface JianyingTrack {
  id: string;
  type: "video" | "audio" | "text";
  segments: JianyingSegment[];
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
  materials: {
    videos: Record<string, unknown>[];
    audios: Record<string, unknown>[];
    texts: Record<string, unknown>[];
    [key: string]: unknown[];
  };
  tracks: Record<string, unknown>[];
  version: number;
  [key: string]: unknown;
}
```

**Step 2: Write the failing test for DraftBuilder**

```typescript
// packages/studio/src/providers/compositor/jianying/draft.test.ts
import { describe, it, expect } from "vitest";
import { DraftBuilder } from "./draft.js";

describe("DraftBuilder", () => {
  it("creates a minimal draft structure", () => {
    const builder = new DraftBuilder("Test Project", { width: 1080, height: 1920 });
    const draft = builder.build();

    expect(draft.canvas_config.width).toBe(1080);
    expect(draft.canvas_config.height).toBe(1920);
    expect(draft.fps).toBe(30);
    expect(draft.version).toBe(360000);
    expect(draft.tracks).toEqual([]);
  });

  it("adds a video segment", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addVideo({
      path: "/tmp/clip.mp4",
      startUs: 0,
      durationUs: 5_000_000,
      width: 1080,
      height: 1920,
    });
    const draft = builder.build();

    expect(draft.tracks.length).toBe(1);
    expect(draft.materials.videos.length).toBe(1);
    expect((draft.materials.videos[0] as { path: string }).path).toBe("/tmp/clip.mp4");
  });

  it("adds an audio segment", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addAudio({
      path: "/tmp/tts.mp3",
      startUs: 0,
      durationUs: 3_200_000,
    });
    const draft = builder.build();

    expect(draft.tracks.length).toBe(1);
    const track = draft.tracks[0] as { type: string };
    expect(track.type).toBe("audio");
  });

  it("adds an image segment (for card screenshots)", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addImage({
      path: "/tmp/card.png",
      startUs: 0,
      durationUs: 3_000_000,
      width: 1080,
      height: 1920,
    });
    const draft = builder.build();

    expect(draft.tracks.length).toBe(1);
    expect(draft.materials.videos.length).toBe(1); // images go in videos array in Jianying
  });

  it("adds subtitle text segments", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addSubtitle({
      text: "你好世界",
      startUs: 0,
      durationUs: 2_000_000,
    });
    const draft = builder.build();

    expect(draft.tracks.length).toBe(1);
    expect(draft.materials.texts.length).toBe(1);
  });

  it("calculates total duration from all segments", () => {
    const builder = new DraftBuilder("Test", { width: 1080, height: 1920 });
    builder.addAudio({ path: "/a.mp3", startUs: 0, durationUs: 3_000_000 });
    builder.addAudio({ path: "/b.mp3", startUs: 3_000_000, durationUs: 2_000_000 });
    const draft = builder.build();

    expect(draft.duration).toBe(5_000_000);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/compositor/jianying/draft.test.ts`
Expected: FAIL

**Step 4: Write DraftBuilder implementation**

```typescript
// packages/studio/src/providers/compositor/jianying/draft.ts
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
    // Jianying treats images as video materials with type "photo"
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
        styles: [{ range: [0, opts.text.length], size: fontSize, bold: false, color }],
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
      fps: 30.0,
      id: uuid(),
      name: this.projectName,
      version: 360000,
      platform: { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "mac" },
      materials: {
        videos: this.materials.videos,
        audios: this.materials.audios,
        texts: this.materials.texts,
      },
      tracks,
      keyframes: { videos: [], audios: [], texts: [], effects: [], filters: [], adjusts: [], stickers: [], handwrites: [] },
    };
  }

  private updateMaxEnd(end: number): void {
    if (end > this.maxEnd) this.maxEnd = end;
  }
}
```

**Step 5: Run test to verify it passes**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/compositor/jianying/draft.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/studio/src/providers/compositor/jianying/
git commit -m "feat(studio): add Jianying draft builder for project file generation"
```

---

### Task 6: Jianying Exporter (Timeline → Draft)

**Files:**
- Create: `packages/studio/src/providers/compositor/jianying/exporter.ts`
- Create: `packages/studio/src/providers/compositor/jianying/exporter.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/studio/src/providers/compositor/jianying/exporter.test.ts
import { describe, it, expect, vi } from "vitest";
import { JianyingExporter } from "./exporter.js";
import type { Timeline } from "../../../../src/types/timeline.js";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const sampleTimeline: Timeline = {
  version: "2.0",
  contentId: "test-123",
  preset: "knowledge-explainer",
  aspectRatio: "9:16",
  subtitle: { template: "modern-outline", position: "bottom" },
  tracks: {
    tts: [
      { id: "tts-001", text: "你好世界", estimatedDuration: 2, start: 0, asset: "/tmp/tts-001.mp3", status: "confirmed" },
      { id: "tts-002", text: "第二段", estimatedDuration: 1.5, start: 2, asset: "/tmp/tts-002.mp3", status: "confirmed" },
    ],
    visual: [
      { id: "vis-001", layer: 0, type: "card", template: "key-points", data: { items: ["a", "b"] }, linkedTts: ["tts-001"], asset: "/tmp/vis-001.png", status: "confirmed" },
      { id: "vis-002", layer: 0, type: "broll", prompt: "city", linkedTts: ["tts-002"], asset: "/tmp/vis-002.mp4", status: "confirmed" },
    ],
    subtitle: { asset: null, status: "pending" },
  },
};

describe("JianyingExporter", () => {
  it("converts timeline to Jianying draft", async () => {
    const exporter = new JianyingExporter();
    const result = await exporter.export(sampleTimeline, "/tmp/drafts/test-project");

    expect(result.path).toBe("/tmp/drafts/test-project");
    expect(result.format).toBe("jianying");
  });

  it("maps TTS segments to audio track", async () => {
    const exporter = new JianyingExporter();
    const draft = exporter.timelineToDraft(sampleTimeline);

    const audioTracks = draft.tracks.filter((t: Record<string, unknown>) => t.type === "audio");
    expect(audioTracks.length).toBe(1);
    expect(draft.materials.audios.length).toBe(2);
  });

  it("maps card visuals to image track and broll to video track", async () => {
    const exporter = new JianyingExporter();
    const draft = exporter.timelineToDraft(sampleTimeline);

    // Should have video materials for both card (image) and broll (video)
    expect(draft.materials.videos.length).toBe(2);
  });

  it("skips segments without confirmed assets", async () => {
    const timeline: Timeline = {
      ...sampleTimeline,
      tracks: {
        ...sampleTimeline.tracks,
        tts: [
          { id: "tts-001", text: "你好", estimatedDuration: 1, start: 0, asset: null, status: "pending" },
        ],
      },
    };
    const exporter = new JianyingExporter();
    const draft = exporter.timelineToDraft(timeline);

    expect(draft.materials.audios.length).toBe(0);
  });
});
```

Note: The import path for Timeline will depend on how the workspace resolves the core package. If core types aren't accessible via workspace, copy the Timeline type or use a path alias. Adjust the import path as needed during implementation.

**Step 2: Run test to verify it fails**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/compositor/jianying/exporter.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// packages/studio/src/providers/compositor/jianying/exporter.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DraftBuilder } from "./draft.js";
// Import Timeline type from core — adjust path based on workspace config
import type { Timeline, VisualSegment, TTSSegment } from "../../../../src/types/timeline.js";

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
  timelineToDraft(timeline: Timeline) {
    const dim = DIMENSIONS[timeline.aspectRatio] ?? DIMENSIONS["9:16"];
    const builder = new DraftBuilder(
      `AutoCrew-${timeline.contentId}`,
      dim,
    );

    // Build TTS lookup for duration calculation
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

    // Add subtitles
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

      // Calculate visual start and duration from linked TTS segments
      const linkedSegs = vis.linkedTts
        .map((id) => ttsMap.get(id))
        .filter((s): s is TTSSegment => s !== undefined);

      if (linkedSegs.length === 0) continue;

      const start = Math.min(...linkedSegs.map((s) => s.start));
      const end = Math.max(...linkedSegs.map((s) => s.start + s.estimatedDuration));
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
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/compositor/jianying/exporter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/studio/src/providers/compositor/jianying/
git commit -m "feat(studio): add Jianying exporter — Timeline to draft_content.json"
```

---

### Task 7: FFmpeg Compositor

**Files:**
- Create: `packages/studio/src/providers/compositor/ffmpeg.ts`
- Create: `packages/studio/src/providers/compositor/ffmpeg.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/studio/src/providers/compositor/ffmpeg.test.ts
import { describe, it, expect, vi } from "vitest";
import { FFmpegCompositor } from "./ffmpeg.js";

// Mock fluent-ffmpeg
vi.mock("fluent-ffmpeg", () => {
  const mock = vi.fn(() => ({
    input: vi.fn().mockReturnThis(),
    complexFilter: vi.fn().mockReturnThis(),
    outputOptions: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    on: vi.fn(function (this: Record<string, unknown>, event: string, cb: () => void) {
      if (event === "end") setTimeout(cb, 0);
      return this;
    }),
    run: vi.fn(),
  }));
  return { default: mock };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe("FFmpegCompositor", () => {
  it("composes timeline assets into mp4", async () => {
    const compositor = new FFmpegCompositor();
    const result = await compositor.compose(
      {
        audioSegments: [{ path: "/tmp/tts.mp3", startSec: 0, durationSec: 3 }],
        videoSegments: [{ path: "/tmp/clip.mp4", startSec: 0, durationSec: 3 }],
        imageSegments: [],
        canvas: { width: 1080, height: 1920 },
      },
      "/tmp/output.mp4"
    );

    expect(result.path).toBe("/tmp/output.mp4");
    expect(result.format).toBe("mp4");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/compositor/ffmpeg.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// packages/studio/src/providers/compositor/ffmpeg.ts
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
  async compose(input: ComposeInput, outputPath: string): Promise<ComposeResult> {
    await mkdir(dirname(outputPath), { recursive: true });

    const totalDuration = Math.max(
      ...input.audioSegments.map((s) => s.startSec + s.durationSec),
      ...input.videoSegments.map((s) => s.startSec + s.durationSec),
      ...input.imageSegments.map((s) => s.startSec + s.durationSec),
      0,
    );

    return new Promise((resolve, reject) => {
      let cmd = ffmpeg();

      // Add all video/image inputs
      for (const seg of [...input.videoSegments, ...input.imageSegments]) {
        cmd = cmd.input(seg.path);
      }

      // Add all audio inputs
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
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/providers/compositor/ffmpeg.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/studio/src/providers/compositor/ffmpeg.ts packages/studio/src/providers/compositor/ffmpeg.test.ts
git commit -m "feat(studio): add FFmpeg compositor for local video rendering"
```

---

### Task 8: Render Pipeline

**Files:**
- Create: `packages/studio/src/pipeline/render.ts`
- Create: `packages/studio/src/pipeline/render.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/studio/src/pipeline/render.test.ts
import { describe, it, expect, vi } from "vitest";
import { renderTimeline, type RenderOptions } from "./render.js";
import type { Timeline } from "../../../../src/types/timeline.js";

const mockTTS = {
  name: "mock",
  generate: vi.fn().mockResolvedValue({ path: "/tmp/tts.mp3", duration: 2, format: "mp3" as const }),
  estimateDuration: vi.fn().mockReturnValue(2),
  listVoices: vi.fn().mockResolvedValue([]),
};

const mockScreenshot = {
  capture: vi.fn().mockResolvedValue({ path: "/tmp/card.png", width: 1080, height: 1920, format: "png" as const }),
};

const mockJianying = {
  export: vi.fn().mockResolvedValue({ path: "/tmp/draft", format: "jianying" as const }),
  timelineToDraft: vi.fn().mockReturnValue({}),
};

const timeline: Timeline = {
  version: "2.0",
  contentId: "test-123",
  preset: "knowledge-explainer",
  aspectRatio: "9:16",
  subtitle: { template: "modern-outline", position: "bottom" },
  tracks: {
    tts: [
      { id: "tts-001", text: "你好世界", estimatedDuration: 2, start: 0, asset: null, status: "confirmed" },
    ],
    visual: [
      { id: "vis-001", layer: 0, type: "card", template: "key-points", data: { items: ["a"] }, linkedTts: ["tts-001"], asset: null, status: "confirmed" },
    ],
    subtitle: { asset: null, status: "pending" },
  },
};

describe("renderTimeline", () => {
  it("generates TTS for all confirmed segments", async () => {
    const opts: RenderOptions = {
      timeline,
      outputDir: "/tmp/render",
      tts: mockTTS,
      screenshot: mockScreenshot,
      exporter: mockJianying,
      voice: { voiceId: "BV700_V2_streaming" },
    };

    await renderTimeline(opts);

    expect(mockTTS.generate).toHaveBeenCalledOnce();
    expect(mockTTS.generate.mock.calls[0][0]).toBe("你好世界");
  });

  it("screenshots card segments", async () => {
    const opts: RenderOptions = {
      timeline,
      outputDir: "/tmp/render",
      tts: mockTTS,
      screenshot: mockScreenshot,
      exporter: mockJianying,
      voice: { voiceId: "BV700_V2_streaming" },
    };

    await renderTimeline(opts);

    expect(mockScreenshot.capture).toHaveBeenCalledOnce();
  });

  it("exports to jianying after asset generation", async () => {
    const opts: RenderOptions = {
      timeline,
      outputDir: "/tmp/render",
      tts: mockTTS,
      screenshot: mockScreenshot,
      exporter: mockJianying,
      voice: { voiceId: "BV700_V2_streaming" },
    };

    await renderTimeline(opts);

    expect(mockJianying.export).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/pipeline/render.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// packages/studio/src/pipeline/render.ts
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Timeline } from "../../../../src/types/timeline.js";

export interface RenderOptions {
  timeline: Timeline;
  outputDir: string;
  tts: {
    generate(text: string, voice: { voiceId: string }, outputPath: string): Promise<{ path: string; duration: number; format: string }>;
  };
  screenshot: {
    capture(html: string, viewport: { width: number; height: number }, outputPath: string): Promise<{ path: string }>;
  };
  exporter: {
    export(timeline: Timeline, outputDir: string): Promise<{ path: string; format: string }>;
  };
  voice: { voiceId: string };
  renderCard?: (template: string, data: Record<string, unknown>, options?: { aspectRatio?: string }) => string;
}

const DIMENSIONS: Record<string, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
};

export async function renderTimeline(opts: RenderOptions): Promise<{ path: string; format: string }> {
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
    .filter((vis) => vis.type === "card" && vis.status === "confirmed" && !vis.asset && vis.template && vis.data)
    .map(async (vis) => {
      const outPath = join(assetsDir, `${vis.id}.png`);
      // If renderCard is provided, use it; otherwise create basic HTML
      const html = opts.renderCard
        ? opts.renderCard(vis.template!, vis.data!, { aspectRatio: timeline.aspectRatio })
        : `<html><body><h1>${vis.template}</h1><pre>${JSON.stringify(vis.data)}</pre></body></html>`;
      const result = await screenshot.capture(html, dim, outPath);
      vis.asset = result.path;
    });

  await Promise.all(cardPromises);

  // 3. Export (Jianying or FFmpeg)
  const result = await exporter.export(timeline, join(outputDir, "draft"));

  return { path: result.path, format: result.format };
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run src/pipeline/render.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/studio/src/pipeline/
git commit -m "feat(studio): add render pipeline — orchestrates TTS, screenshot, and export"
```

---

### Task 9: Public API and Index

**Files:**
- Create: `packages/studio/src/index.ts`

**Step 1: Write the barrel export**

```typescript
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
```

**Step 2: Commit**

```bash
git add packages/studio/src/index.ts
git commit -m "feat(studio): add public API barrel export"
```

---

### Task 10: Integration Smoke Test

**Files:**
- Create: `packages/studio/tests/integration.test.ts`

**Step 1: Write integration test**

```typescript
// packages/studio/tests/integration.test.ts
import { describe, it, expect, vi } from "vitest";
import { DoubaoTTS } from "../src/providers/tts/doubao.js";
import { PuppeteerScreenshot } from "../src/providers/screenshot/puppeteer.js";
import { JianyingExporter } from "../src/providers/compositor/jianying/exporter.js";
import { DraftBuilder } from "../src/providers/compositor/jianying/draft.js";
import { renderTimeline } from "../src/pipeline/render.js";
import { loadConfig } from "../src/config/index.js";

describe("@autocrew/studio integration", () => {
  it("all exports are importable", () => {
    expect(DoubaoTTS).toBeDefined();
    expect(PuppeteerScreenshot).toBeDefined();
    expect(JianyingExporter).toBeDefined();
    expect(DraftBuilder).toBeDefined();
    expect(renderTimeline).toBeDefined();
    expect(loadConfig).toBeDefined();
  });

  it("DraftBuilder produces valid Jianying JSON structure", () => {
    const builder = new DraftBuilder("Smoke Test", { width: 1080, height: 1920 });
    builder
      .addAudio({ path: "/tmp/a.mp3", startUs: 0, durationUs: 3_000_000 })
      .addImage({ path: "/tmp/card.png", startUs: 0, durationUs: 3_000_000, width: 1080, height: 1920 })
      .addSubtitle({ text: "测试字幕", startUs: 0, durationUs: 3_000_000 });

    const draft = builder.build();

    // Verify Jianying format requirements
    expect(draft.version).toBe(360000);
    expect(draft.fps).toBe(30);
    expect(draft.canvas_config.width).toBe(1080);
    expect(draft.duration).toBe(3_000_000);
    expect(draft.tracks.length).toBe(3); // image + audio + subtitle
    expect(draft.materials.audios.length).toBe(1);
    expect(draft.materials.videos.length).toBe(1);
    expect(draft.materials.texts.length).toBe(1);

    // Verify JSON serializable (no circular refs, no undefined)
    const json = JSON.stringify(draft);
    expect(json).toBeDefined();
    const parsed = JSON.parse(json);
    expect(parsed.canvas_config.width).toBe(1080);
  });
});
```

**Step 2: Run all studio tests**

Run: `cd /Users/jiaxintang/AutoCrew/packages/studio && npx vitest run`
Expected: All tests PASS

**Step 3: Run core tests to ensure no regression**

Run: `cd /Users/jiaxintang/AutoCrew && npx vitest run`
Expected: All existing 341 tests PASS

**Step 4: Commit**

```bash
git add packages/studio/tests/
git commit -m "test(studio): add integration smoke test for all exports"
```
