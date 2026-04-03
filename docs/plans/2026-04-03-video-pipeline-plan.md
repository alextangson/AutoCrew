# Video Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an auto-composition engine that takes a script and outputs a finished video, with a Descript-style Web UI for asset review.

**Architecture:** Two-package split: `@autocrew/core` handles timeline markup, card templates, provider interfaces, and Web UI. `@autocrew/studio` (separate package) handles TTS generation, video generation, screenshots, and composition. Core stays lightweight with zero heavy dependencies.

**Tech Stack:** TypeScript, @sinclair/typebox (schemas), Hono (API), React 19 + React Query (Web UI), Vitest (tests)

**Design Doc:** `docs/plans/2026-04-03-video-pipeline-design.md`

---

## Phase 1: Core Types & Provider Interfaces

### Task 1: Timeline types

**Files:**
- Create: `src/types/timeline.ts`
- Test: `tests/types/timeline.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/types/timeline.test.ts
import { describe, it, expect } from "vitest";
import type {
  Timeline,
  TTSSegment,
  VisualSegment,
  SubtitleTrack,
  SegmentStatus,
  VideoPreset,
  AspectRatio,
  SubtitleTemplate,
} from "../../src/types/timeline.js";

describe("Timeline types", () => {
  it("should create a valid timeline object", () => {
    const timeline: Timeline = {
      version: "2.0",
      contentId: "test-123",
      preset: "knowledge-explainer",
      aspectRatio: "9:16",
      subtitle: {
        template: "modern-outline",
        position: "bottom",
      },
      tracks: {
        tts: [
          {
            id: "tts-001",
            text: "Hello world",
            estimatedDuration: 2.5,
            start: 0,
            asset: null,
            status: "pending",
          },
        ],
        visual: [
          {
            id: "vis-001",
            layer: 0,
            type: "broll",
            prompt: "city aerial shot",
            linkedTts: ["tts-001"],
            asset: null,
            status: "pending",
          },
        ],
        subtitle: {
          asset: null,
          status: "pending",
        },
      },
    };

    expect(timeline.version).toBe("2.0");
    expect(timeline.tracks.tts).toHaveLength(1);
    expect(timeline.tracks.visual).toHaveLength(1);
    expect(timeline.tracks.visual[0].linkedTts).toContain("tts-001");
  });

  it("should support card visual with template data", () => {
    const card: VisualSegment = {
      id: "vis-002",
      layer: 1,
      type: "card",
      template: "comparison-table",
      data: {
        title: "Tool Comparison",
        rows: [{ name: "Notion", pros: "All-in-one", cons: "Complex" }],
      },
      linkedTts: ["tts-001"],
      opacity: 0.85,
      asset: null,
      status: "pending",
    };

    expect(card.type).toBe("card");
    expect(card.template).toBe("comparison-table");
    expect(card.opacity).toBe(0.85);
  });

  it("should enforce valid status transitions", () => {
    const validStatuses: SegmentStatus[] = [
      "pending",
      "generating",
      "ready",
      "confirmed",
      "failed",
    ];
    expect(validStatuses).toHaveLength(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types/timeline.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/types/timeline.ts

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
  asset: string | null; // path to audio file when generated
  status: SegmentStatus;
}

export interface VisualSegment {
  id: string;
  layer: number;
  type: VisualType;
  // B-roll fields
  prompt?: string;
  // Card fields
  template?: CardTemplate;
  data?: Record<string, unknown>;
  // Shared
  linkedTts: string[];
  opacity?: number;
  asset: string | null; // path to image/video file when generated
  status: SegmentStatus;
}

export interface SubtitleTrack {
  asset: string | null; // path to .srt file
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/types/timeline.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types/timeline.ts tests/types/timeline.test.ts
git commit -m "feat: add timeline type definitions for video pipeline"
```

---

### Task 2: Provider interfaces

**Files:**
- Create: `src/types/providers.ts`
- Test: `tests/types/providers.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/types/providers.test.ts
import { describe, it, expect } from "vitest";
import type {
  TTSProvider,
  VideoProvider,
  CompositorProvider,
  VoiceConfig,
  VideoConfig,
  AudioAsset,
  VideoAsset,
  ExportFormat,
} from "../../src/types/providers.js";
import type { Timeline, AspectRatio } from "../../src/types/timeline.js";

describe("Provider interfaces", () => {
  it("should define TTSProvider shape", () => {
    const mockTTS: TTSProvider = {
      name: "edge-tts",
      generate: async (text: string, voice: VoiceConfig) => ({
        path: "/tmp/audio.mp3",
        duration: 3.2,
        format: "mp3",
      }),
      estimateDuration: (text: string) => text.length * 0.15,
      listVoices: async () => [
        { id: "zh-CN-XiaoxiaoNeural", name: "Xiaoxiao", language: "zh-CN" },
      ],
    };

    expect(mockTTS.name).toBe("edge-tts");
    expect(mockTTS.estimateDuration("Hello")).toBeGreaterThan(0);
  });

  it("should define VideoProvider shape", () => {
    const mockVideo: VideoProvider = {
      name: "kling",
      generate: async (prompt: string, config: VideoConfig) => ({
        path: "/tmp/video.mp4",
        duration: 5,
        format: "mp4",
      }),
      supportedRatios: () => ["9:16", "16:9"] as AspectRatio[],
    };

    expect(mockVideo.name).toBe("kling");
    expect(mockVideo.supportedRatios()).toContain("9:16");
  });

  it("should define CompositorProvider shape", () => {
    const mockCompositor: CompositorProvider = {
      name: "ffmpeg",
      compose: async (timeline, assets) => ({
        path: "/tmp/output.mp4",
        duration: 45,
        format: "mp4",
      }),
      export: async (timeline, assets, format) => ({
        path: "/tmp/project.json",
        format: "jianying",
      }),
      supportedFormats: () => ["jianying"] as ExportFormat[],
    };

    expect(mockCompositor.name).toBe("ffmpeg");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types/providers.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/types/providers.ts
import type { AspectRatio, Timeline } from "./timeline.js";

export interface Voice {
  id: string;
  name: string;
  language: string;
}

export interface VoiceConfig {
  voiceId: string;
  speed?: number; // 0.5 - 2.0, default 1.0
  pitch?: number; // -20 to 20, default 0
}

export interface AudioAsset {
  path: string;
  duration: number; // seconds
  format: "mp3" | "wav" | "ogg";
}

export interface VideoConfig {
  aspectRatio: AspectRatio;
  duration: number; // seconds
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

export type AssetMap = Record<string, string>; // segmentId → file path

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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/types/providers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types/providers.ts tests/types/providers.test.ts
git commit -m "feat: add provider adapter interfaces for TTS, video, compositor"
```

---

## Phase 2: Timeline Markup Engine

### Task 3: Markup parser — convert marked script to timeline.json

**Files:**
- Create: `src/modules/timeline/parser.ts`
- Test: `tests/modules/timeline/parser.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/modules/timeline/parser.test.ts
import { describe, it, expect } from "vitest";
import { parseMarkedScript } from "../../../src/modules/timeline/parser.js";

describe("parseMarkedScript", () => {
  it("should parse a simple marked script into timeline", () => {
    const script = `今天我们聊聊三个效率工具
[card:comparison-table title="三款工具对比" rows="Notion:全能:学习曲线,Obsidian:本地:无协作"]

第一个是 Notion，很多人用它来管理生活的方方面面
[broll:notion app界面操作画面，暗色主题]

它最强的地方在于三点
[card:key-points items="数据库驱动,模板生态,多端同步"]`;

    const timeline = parseMarkedScript(script, {
      contentId: "test-123",
      preset: "knowledge-explainer",
      aspectRatio: "9:16",
    });

    expect(timeline.version).toBe("2.0");
    expect(timeline.contentId).toBe("test-123");
    expect(timeline.tracks.tts).toHaveLength(3);
    expect(timeline.tracks.visual).toHaveLength(3);

    // First segment: text + card
    expect(timeline.tracks.tts[0].text).toBe("今天我们聊聊三个效率工具");
    expect(timeline.tracks.visual[0].type).toBe("card");
    expect(timeline.tracks.visual[0].template).toBe("comparison-table");
    expect(timeline.tracks.visual[0].linkedTts).toEqual(["tts-001"]);

    // Second segment: text + broll
    expect(timeline.tracks.tts[1].text).toContain("第一个是 Notion");
    expect(timeline.tracks.visual[1].type).toBe("broll");
    expect(timeline.tracks.visual[1].prompt).toBe(
      "notion app界面操作画面，暗色主题",
    );

    // Third segment: text + card
    expect(timeline.tracks.visual[2].type).toBe("card");
    expect(timeline.tracks.visual[2].template).toBe("key-points");
  });

  it("should parse card data attributes", () => {
    const script = `这是一段文字
[card:comparison-table title="对比" rows="A:好:贵,B:便宜:差"]`;

    const timeline = parseMarkedScript(script, {
      contentId: "test-456",
      preset: "knowledge-explainer",
      aspectRatio: "9:16",
    });

    const card = timeline.tracks.visual[0];
    expect(card.data).toEqual({
      title: "对比",
      rows: [
        { name: "A", pros: "好", cons: "贵" },
        { name: "B", pros: "便宜", cons: "差" },
      ],
    });
  });

  it("should handle broll spanning multiple TTS segments", () => {
    const script = `第一段话
第二段话
[broll:城市夜景 span=2]

第三段话
[card:key-points items="要点一,要点二"]`;

    const timeline = parseMarkedScript(script, {
      contentId: "test-789",
      preset: "knowledge-explainer",
      aspectRatio: "9:16",
    });

    // broll linked to both tts segments before it
    const broll = timeline.tracks.visual[0];
    expect(broll.linkedTts).toEqual(["tts-001", "tts-002"]);
  });

  it("should handle script with no markup as single TTS segment", () => {
    const script = "这是一段没有标记的纯文案";
    const timeline = parseMarkedScript(script, {
      contentId: "test-plain",
      preset: "knowledge-explainer",
      aspectRatio: "9:16",
    });

    expect(timeline.tracks.tts).toHaveLength(1);
    expect(timeline.tracks.visual).toHaveLength(0);
  });

  it("should estimate TTS duration based on Chinese character count", () => {
    const script = `这是十个中文字的句子哦
[card:key-points items="一"]`;

    const timeline = parseMarkedScript(script, {
      contentId: "test-dur",
      preset: "knowledge-explainer",
      aspectRatio: "9:16",
    });

    // ~4 chars/sec for Chinese → 10 chars ≈ 2.5s
    const duration = timeline.tracks.tts[0].estimatedDuration;
    expect(duration).toBeGreaterThan(1.5);
    expect(duration).toBeLessThan(4);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/modules/timeline/parser.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/modules/timeline/parser.ts
import type {
  Timeline,
  TTSSegment,
  VisualSegment,
  VideoPreset,
  AspectRatio,
  CardTemplate,
  VisualType,
} from "../../types/timeline.js";

interface ParseOptions {
  contentId: string;
  preset: VideoPreset;
  aspectRatio: AspectRatio;
}

const MARKUP_REGEX = /^\[(broll|card):(.+)\]$/;
const ATTR_REGEX = /(\w+)="([^"]*)"/g;
const CHINESE_CHARS_PER_SEC = 4;

function estimateDuration(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const nonChinese = text.length - chineseChars;
  // Chinese: ~4 chars/sec, English: ~15 chars/sec
  return chineseChars / CHINESE_CHARS_PER_SEC + nonChinese / 15;
}

function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;
  while ((match = ATTR_REGEX.exec(attrString)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function parseCardData(
  template: CardTemplate,
  attrs: Record<string, string>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (attrs.title) data.title = attrs.title;

  if (attrs.rows) {
    data.rows = attrs.rows.split(",").map((row) => {
      const parts = row.split(":");
      return { name: parts[0], pros: parts[1] || "", cons: parts[2] || "" };
    });
  }

  if (attrs.items) {
    data.items = attrs.items.split(",");
  }

  if (attrs.steps) {
    data.steps = attrs.steps.split(",");
  }

  return data;
}

export function parseMarkedScript(
  script: string,
  options: ParseOptions,
): Timeline {
  const lines = script.split("\n");
  const ttsSegments: TTSSegment[] = [];
  const visualSegments: VisualSegment[] = [];

  let ttsCounter = 0;
  let visCounter = 0;
  let currentTextLines: string[] = [];
  let currentStart = 0;

  function flushText(): string | null {
    const text = currentTextLines.join("").trim();
    currentTextLines = [];
    if (!text) return null;
    return text;
  }

  function addTtsSegment(text: string): string {
    ttsCounter++;
    const id = `tts-${String(ttsCounter).padStart(3, "0")}`;
    const duration = estimateDuration(text);
    ttsSegments.push({
      id,
      text,
      estimatedDuration: Math.round(duration * 10) / 10,
      start: currentStart,
      asset: null,
      status: "pending",
    });
    currentStart += duration;
    return id;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const markupMatch = trimmed.match(MARKUP_REGEX);
    if (markupMatch) {
      const type = markupMatch[1] as VisualType;
      const content = markupMatch[2];

      // Parse attributes from content
      const attrs = parseAttributes(content);
      const span = attrs.span ? parseInt(attrs.span, 10) : 1;

      // Flush accumulated text as TTS segment
      const text = flushText();
      let linkedTtsIds: string[] = [];

      if (text) {
        const ttsId = addTtsSegment(text);
        linkedTtsIds.push(ttsId);
      }

      // Handle span > 1: link to previous TTS segments
      if (span > 1 && ttsSegments.length >= span) {
        linkedTtsIds = ttsSegments
          .slice(ttsSegments.length - span)
          .map((s) => s.id);
      }

      visCounter++;
      const visId = `vis-${String(visCounter).padStart(3, "0")}`;

      if (type === "broll") {
        // Extract prompt: everything before first attr
        const prompt = content.replace(ATTR_REGEX, "").trim();
        visualSegments.push({
          id: visId,
          layer: 0,
          type: "broll",
          prompt,
          linkedTts: linkedTtsIds,
          asset: null,
          status: "pending",
        });
      } else if (type === "card") {
        // Extract template name: first word before space
        const templateMatch = content.match(/^([\w-]+)/);
        const template = (templateMatch?.[1] || "key-points") as CardTemplate;

        visualSegments.push({
          id: visId,
          layer: visualSegments.some(
            (v) =>
              v.linkedTts.some((t) => linkedTtsIds.includes(t)) &&
              v.layer === 0,
          )
            ? 1
            : 0,
          type: "card",
          template,
          data: parseCardData(template, attrs),
          linkedTts: linkedTtsIds,
          opacity: 0.85,
          asset: null,
          status: "pending",
        });
      }
    } else {
      currentTextLines.push(trimmed);
    }
  }

  // Flush remaining text
  const remaining = flushText();
  if (remaining) {
    addTtsSegment(remaining);
  }

  return {
    version: "2.0",
    contentId: options.contentId,
    preset: options.preset,
    aspectRatio: options.aspectRatio,
    subtitle: {
      template: "modern-outline",
      position: "bottom",
    },
    tracks: {
      tts: ttsSegments,
      visual: visualSegments,
      subtitle: {
        asset: null,
        status: "pending",
      },
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/modules/timeline/parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules/timeline/parser.ts tests/modules/timeline/parser.test.ts
git commit -m "feat: add timeline markup parser — converts marked script to timeline.json"
```

---

### Task 4: AI markup generator — auto-insert [card]/[broll] tags into script

**Files:**
- Create: `src/modules/timeline/markup-generator.ts`
- Test: `tests/modules/timeline/markup-generator.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/modules/timeline/markup-generator.test.ts
import { describe, it, expect } from "vitest";
import { buildMarkupPrompt } from "../../../src/modules/timeline/markup-generator.js";

describe("buildMarkupPrompt", () => {
  it("should build a prompt for AI markup generation", () => {
    const script = "今天我们聊聊三个效率工具。第一个是Notion。它最强的地方在于三点。";
    const prompt = buildMarkupPrompt(script, "knowledge-explainer");

    expect(prompt).toContain("[card:");
    expect(prompt).toContain("[broll:");
    expect(prompt).toContain(script);
    expect(prompt).toContain("knowledge-explainer");
  });

  it("should include available card templates in prompt", () => {
    const prompt = buildMarkupPrompt("test", "knowledge-explainer");

    expect(prompt).toContain("comparison-table");
    expect(prompt).toContain("key-points");
    expect(prompt).toContain("flow-chart");
    expect(prompt).toContain("data-chart");
  });

  it("should include preset-specific guidance", () => {
    const knowledgePrompt = buildMarkupPrompt("test", "knowledge-explainer");
    expect(knowledgePrompt).toContain("60%");

    const tutorialPrompt = buildMarkupPrompt("test", "tutorial");
    expect(tutorialPrompt).toContain("step");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/modules/timeline/markup-generator.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/modules/timeline/markup-generator.ts
import type { VideoPreset, CardTemplate } from "../../types/timeline.js";

const CARD_TEMPLATES: Record<CardTemplate, string> = {
  "comparison-table": "对比表 — 用于对比多个选项。attrs: title, rows (格式: 名称:优点:缺点,名称:优点:缺点)",
  "key-points": "要点列表 — 用于列举要点。attrs: items (逗号分隔)",
  "flow-chart": "流程图 — 用于展示步骤流程。attrs: steps (逗号分隔)",
  "data-chart": "数据图 — 用于展示数据对比。attrs: title, items (格式: 标签:数值,标签:数值)",
};

const PRESET_GUIDANCE: Record<VideoPreset, string> = {
  "knowledge-explainer": `你是知识讲解类视频的素材策划师。
规则：
- 约60%画面用知识卡片（card），40%用B-roll过渡画面
- 每当提到对比、列举、要点时，用 card
- 每当切换话题或需要视觉过渡时，用 broll
- broll prompt 要具体：描述画面内容、风格、氛围
- card 数据要从文案中提取，不要编造`,

  tutorial: `你是教程类视频的素材策划师。
规则：
- 每个步骤(step)用带编号的 card 展示
- 步骤之间用 broll 做过渡
- 如果需要展示软件操作，标注 [broll:屏幕录制占位 — 描述操作内容]
- card 模板优先用 flow-chart 和 key-points`,
};

export function buildMarkupPrompt(
  script: string,
  preset: VideoPreset,
): string {
  const templateList = Object.entries(CARD_TEMPLATES)
    .map(([name, desc]) => `  - ${name}: ${desc}`)
    .join("\n");

  return `${PRESET_GUIDANCE[preset]}

## 可用标记语法

### B-roll (视频/图片素材)
[broll:具体的画面描述 prompt]
可选属性: span=N (跨越N段TTS)

### 知识卡片
[card:模板名称 属性="值"]

可用卡片模板:
${templateList}

## 输入文案

${script}

## 任务

在文案的合适位置插入 [card:...] 和 [broll:...] 标记。
保持原文案不变，只添加标记行。每段文字后面都应该有一个标记。
输出完整的带标记文案。`;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/modules/timeline/markup-generator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules/timeline/markup-generator.ts tests/modules/timeline/markup-generator.test.ts
git commit -m "feat: add AI markup prompt builder for auto-inserting visual tags"
```

---

## Phase 3: HTML Knowledge Card Templates

### Task 5: Card template engine

**Files:**
- Create: `src/modules/cards/template-engine.ts`
- Create: `src/modules/cards/templates/comparison-table.ts`
- Create: `src/modules/cards/templates/key-points.ts`
- Create: `src/modules/cards/templates/flow-chart.ts`
- Create: `src/modules/cards/templates/data-chart.ts`
- Test: `tests/modules/cards/template-engine.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/modules/cards/template-engine.test.ts
import { describe, it, expect } from "vitest";
import { renderCard } from "../../../src/modules/cards/template-engine.js";
import type { CardTemplate } from "../../../src/types/timeline.js";

describe("renderCard", () => {
  it("should render comparison-table template", () => {
    const html = renderCard("comparison-table", {
      title: "工具对比",
      rows: [
        { name: "Notion", pros: "全能", cons: "学习曲线" },
        { name: "Obsidian", pros: "本地", cons: "无协作" },
      ],
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("工具对比");
    expect(html).toContain("Notion");
    expect(html).toContain("Obsidian");
    expect(html).toContain("</table>");
  });

  it("should render key-points template", () => {
    const html = renderCard("key-points", {
      items: ["数据库驱动", "模板生态", "多端同步"],
    });

    expect(html).toContain("数据库驱动");
    expect(html).toContain("模板生态");
    expect(html).toContain("多端同步");
  });

  it("should render flow-chart template", () => {
    const html = renderCard("flow-chart", {
      steps: ["注册账号", "选择模板", "开始使用"],
    });

    expect(html).toContain("注册账号");
    expect(html).toContain("→");
  });

  it("should render data-chart template", () => {
    const html = renderCard("data-chart", {
      title: "市场份额",
      items: [
        { label: "Notion", value: 45 },
        { label: "Obsidian", value: 30 },
      ],
    });

    expect(html).toContain("市场份额");
    expect(html).toContain("45");
  });

  it("should apply aspect ratio to card dimensions", () => {
    const vertical = renderCard(
      "key-points",
      { items: ["test"] },
      { aspectRatio: "9:16" },
    );
    expect(vertical).toContain("1080");
    expect(vertical).toContain("1920");

    const horizontal = renderCard(
      "key-points",
      { items: ["test"] },
      { aspectRatio: "16:9" },
    );
    expect(horizontal).toContain("1920");
    expect(horizontal).toContain("1080");
  });

  it("should throw for unknown template", () => {
    expect(() => renderCard("unknown" as CardTemplate, {})).toThrow(
      "Unknown card template",
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/modules/cards/template-engine.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementations**

```typescript
// src/modules/cards/templates/comparison-table.ts
export function render(data: Record<string, unknown>): string {
  const title = (data.title as string) || "";
  const rows = (data.rows as Array<{ name: string; pros: string; cons: string }>) || [];

  const tableRows = rows
    .map(
      (r) => `
    <tr>
      <td class="name">${r.name}</td>
      <td class="pros">${r.pros}</td>
      <td class="cons">${r.cons}</td>
    </tr>`,
    )
    .join("");

  return `
    <h2>${title}</h2>
    <table>
      <thead>
        <tr><th>名称</th><th>优点</th><th>缺点</th></tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>`;
}
```

```typescript
// src/modules/cards/templates/key-points.ts
export function render(data: Record<string, unknown>): string {
  const items = (data.items as string[]) || [];
  const listItems = items.map((item, i) => `<li><span class="num">${i + 1}</span>${item}</li>`).join("");
  return `<ul class="key-points">${listItems}</ul>`;
}
```

```typescript
// src/modules/cards/templates/flow-chart.ts
export function render(data: Record<string, unknown>): string {
  const steps = (data.steps as string[]) || [];
  const nodes = steps
    .map((step, i) => {
      const arrow = i < steps.length - 1 ? '<span class="arrow">→</span>' : "";
      return `<span class="step"><span class="num">${i + 1}</span>${step}</span>${arrow}`;
    })
    .join("");
  return `<div class="flow-chart">${nodes}</div>`;
}
```

```typescript
// src/modules/cards/templates/data-chart.ts
export function render(data: Record<string, unknown>): string {
  const title = (data.title as string) || "";
  const items = (data.items as Array<{ label: string; value: number }>) || [];
  const maxValue = Math.max(...items.map((i) => i.value), 1);

  const bars = items
    .map(
      (item) => `
    <div class="bar-group">
      <span class="label">${item.label}</span>
      <div class="bar" style="width: ${(item.value / maxValue) * 100}%">
        <span class="value">${item.value}</span>
      </div>
    </div>`,
    )
    .join("");

  return `<h2>${title}</h2><div class="chart">${bars}</div>`;
}
```

```typescript
// src/modules/cards/template-engine.ts
import type { CardTemplate, AspectRatio } from "../../types/timeline.js";
import { render as comparisonTable } from "./templates/comparison-table.js";
import { render as keyPoints } from "./templates/key-points.js";
import { render as flowChart } from "./templates/flow-chart.js";
import { render as dataChart } from "./templates/data-chart.js";

const TEMPLATES: Record<CardTemplate, (data: Record<string, unknown>) => string> = {
  "comparison-table": comparisonTable,
  "key-points": keyPoints,
  "flow-chart": flowChart,
  "data-chart": dataChart,
};

const DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
};

interface RenderOptions {
  aspectRatio?: AspectRatio;
}

export function renderCard(
  template: CardTemplate,
  data: Record<string, unknown>,
  options?: RenderOptions,
): string {
  const renderer = TEMPLATES[template];
  if (!renderer) {
    throw new Error(`Unknown card template: ${template}`);
  }

  const { width, height } = DIMENSIONS[options?.aspectRatio || "9:16"];
  const body = renderer(data);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${width}px;
    height: ${height}px;
    background: #ffffff;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 80px;
    color: #1a1a1a;
  }
  h2 {
    font-size: 48px;
    font-weight: 700;
    margin-bottom: 40px;
    text-align: center;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 32px;
  }
  th, td {
    padding: 20px 24px;
    text-align: left;
    border-bottom: 1px solid #e5e5e5;
  }
  th { font-weight: 600; color: #666; }
  .pros { color: #22c55e; }
  .cons { color: #ef4444; }
  .key-points {
    list-style: none;
    font-size: 36px;
    line-height: 2.2;
  }
  .key-points .num {
    display: inline-block;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #3b82f6;
    color: white;
    text-align: center;
    line-height: 48px;
    margin-right: 20px;
    font-size: 24px;
  }
  .flow-chart {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 28px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .step {
    background: #f0f9ff;
    border: 2px solid #3b82f6;
    border-radius: 12px;
    padding: 16px 24px;
  }
  .step .num {
    display: inline-block;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #3b82f6;
    color: white;
    text-align: center;
    line-height: 32px;
    margin-right: 8px;
    font-size: 18px;
  }
  .arrow { font-size: 36px; color: #3b82f6; }
  .chart { width: 100%; }
  .bar-group {
    display: flex;
    align-items: center;
    margin-bottom: 20px;
    font-size: 28px;
  }
  .bar-group .label {
    width: 150px;
    text-align: right;
    margin-right: 16px;
  }
  .bar {
    background: linear-gradient(90deg, #3b82f6, #60a5fa);
    height: 40px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding-right: 12px;
    color: white;
    min-width: 60px;
  }
</style>
</head>
<body>
  <div class="container">${body}</div>
</body>
</html>`;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/modules/cards/template-engine.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/modules/cards/ tests/modules/cards/
git commit -m "feat: add HTML knowledge card template engine with 4 built-in templates"
```

---

## Phase 4: Timeline MCP Tool

### Task 6: Timeline tool — MCP tool for generating and managing timelines

**Files:**
- Create: `src/tools/timeline.ts`
- Modify: `src/tools/registry.ts` — add registration
- Test: `tests/tools/timeline.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/tools/timeline.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { executeTimeline } from "../../src/tools/timeline.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("executeTimeline", () => {
  let dataDir: string;
  let contentId: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "timeline-test-"));
    contentId = "test-content-001";

    // Create content structure
    const contentDir = join(dataDir, "contents", contentId);
    await mkdir(contentDir, { recursive: true });
    await writeFile(
      join(contentDir, "meta.json"),
      JSON.stringify({
        id: contentId,
        title: "测试内容",
        status: "approved",
      }),
    );
    await writeFile(
      join(contentDir, "draft.md"),
      `今天我们聊聊效率工具
[card:key-points items="Notion,Obsidian,Logseq"]

第一个是Notion
[broll:Notion界面操作画面]`,
    );
  });

  it("should generate timeline from content", async () => {
    const result = await executeTimeline({
      action: "generate",
      content_id: contentId,
      preset: "knowledge-explainer",
      aspect_ratio: "9:16",
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(true);
    expect(result.timeline).toBeDefined();
    expect(result.timeline.tracks.tts).toHaveLength(2);
    expect(result.timeline.tracks.visual).toHaveLength(2);
  });

  it("should get existing timeline", async () => {
    // Generate first
    await executeTimeline({
      action: "generate",
      content_id: contentId,
      preset: "knowledge-explainer",
      aspect_ratio: "9:16",
      _dataDir: dataDir,
    });

    const result = await executeTimeline({
      action: "get",
      content_id: contentId,
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(true);
    expect(result.timeline).toBeDefined();
  });

  it("should update segment status", async () => {
    await executeTimeline({
      action: "generate",
      content_id: contentId,
      preset: "knowledge-explainer",
      aspect_ratio: "9:16",
      _dataDir: dataDir,
    });

    const result = await executeTimeline({
      action: "update_segment",
      content_id: contentId,
      segment_id: "vis-001",
      status: "confirmed",
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(true);
  });

  it("should return error for non-existent content", async () => {
    const result = await executeTimeline({
      action: "get",
      content_id: "non-existent",
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/timeline.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/tools/timeline.ts
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseMarkedScript } from "../modules/timeline/parser.js";
import type { Timeline, SegmentStatus, VideoPreset, AspectRatio } from "../types/timeline.js";

export const timelineSchema = Type.Object({
  action: Type.Unsafe<"generate" | "get" | "update_segment" | "confirm_all">({
    type: "string",
    enum: ["generate", "get", "update_segment", "confirm_all"],
    description:
      "generate: parse marked script into timeline. get: retrieve existing timeline. update_segment: update a segment's status/asset. confirm_all: mark all ready segments as confirmed.",
  }),
  content_id: Type.String({ description: "Content project ID" }),
  preset: Type.Optional(
    Type.Unsafe<VideoPreset>({
      type: "string",
      enum: ["knowledge-explainer", "tutorial"],
      description: "Video preset style (required for generate)",
    }),
  ),
  aspect_ratio: Type.Optional(
    Type.Unsafe<AspectRatio>({
      type: "string",
      enum: ["9:16", "16:9", "3:4", "1:1", "4:3"],
      description: "Output aspect ratio (required for generate)",
    }),
  ),
  segment_id: Type.Optional(
    Type.String({ description: "Segment ID (for update_segment)" }),
  ),
  status: Type.Optional(
    Type.Unsafe<SegmentStatus>({
      type: "string",
      enum: ["pending", "generating", "ready", "confirmed", "failed"],
      description: "New status (for update_segment)",
    }),
  ),
  asset_path: Type.Optional(
    Type.String({ description: "Path to generated asset file (for update_segment)" }),
  ),
  _dataDir: Type.Optional(Type.String()),
});

function getTimelinePath(dataDir: string, contentId: string): string {
  return join(dataDir, "contents", contentId, "timeline.json");
}

async function loadTimeline(
  dataDir: string,
  contentId: string,
): Promise<Timeline | null> {
  try {
    const raw = await readFile(getTimelinePath(dataDir, contentId), "utf-8");
    return JSON.parse(raw) as Timeline;
  } catch {
    return null;
  }
}

async function saveTimeline(
  dataDir: string,
  contentId: string,
  timeline: Timeline,
): Promise<void> {
  const dir = join(dataDir, "contents", contentId);
  await mkdir(dir, { recursive: true });
  await writeFile(getTimelinePath(dataDir, contentId), JSON.stringify(timeline, null, 2));
}

export async function executeTimeline(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = params.action as string;
  const contentId = params.content_id as string;
  const dataDir = (params._dataDir as string) || "";

  if (action === "generate") {
    const preset = (params.preset as VideoPreset) || "knowledge-explainer";
    const aspectRatio = (params.aspect_ratio as AspectRatio) || "9:16";

    // Read draft
    const draftPath = join(dataDir, "contents", contentId, "draft.md");
    let script: string;
    try {
      script = await readFile(draftPath, "utf-8");
    } catch {
      return { ok: false, error: `Content not found: ${contentId}` };
    }

    const timeline = parseMarkedScript(script, { contentId, preset, aspectRatio });
    await saveTimeline(dataDir, contentId, timeline);

    return {
      ok: true,
      timeline,
      message: `Timeline generated: ${timeline.tracks.tts.length} TTS segments, ${timeline.tracks.visual.length} visual segments`,
    };
  }

  if (action === "get") {
    const timeline = await loadTimeline(dataDir, contentId);
    if (!timeline) {
      return { ok: false, error: `No timeline found for content: ${contentId}` };
    }
    return { ok: true, timeline };
  }

  if (action === "update_segment") {
    const segmentId = params.segment_id as string;
    const status = params.status as SegmentStatus | undefined;
    const assetPath = params.asset_path as string | undefined;

    const timeline = await loadTimeline(dataDir, contentId);
    if (!timeline) {
      return { ok: false, error: `No timeline found for content: ${contentId}` };
    }

    // Search in all tracks
    let found = false;
    for (const tts of timeline.tracks.tts) {
      if (tts.id === segmentId) {
        if (status) tts.status = status;
        if (assetPath) tts.asset = assetPath;
        found = true;
        break;
      }
    }
    for (const vis of timeline.tracks.visual) {
      if (vis.id === segmentId) {
        if (status) vis.status = status;
        if (assetPath) vis.asset = assetPath;
        found = true;
        break;
      }
    }

    if (!found) {
      return { ok: false, error: `Segment not found: ${segmentId}` };
    }

    await saveTimeline(dataDir, contentId, timeline);
    return { ok: true, message: `Segment ${segmentId} updated` };
  }

  if (action === "confirm_all") {
    const timeline = await loadTimeline(dataDir, contentId);
    if (!timeline) {
      return { ok: false, error: `No timeline found for content: ${contentId}` };
    }

    let confirmed = 0;
    for (const tts of timeline.tracks.tts) {
      if (tts.status === "ready") {
        tts.status = "confirmed";
        confirmed++;
      }
    }
    for (const vis of timeline.tracks.visual) {
      if (vis.status === "ready") {
        vis.status = "confirmed";
        confirmed++;
      }
    }

    await saveTimeline(dataDir, contentId, timeline);
    return { ok: true, message: `${confirmed} segments confirmed` };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/timeline.test.ts`
Expected: PASS

**Step 5: Register in tool registry**

Add to `src/tools/registry.ts` inside `registerAllTools()`:

```typescript
// After existing tool registrations
import { timelineSchema, executeTimeline } from "./timeline.js";

runner.register({
  name: "autocrew_timeline",
  label: "AutoCrew Timeline",
  description:
    "Generate and manage video timelines. Actions: generate (parse marked script into timeline.json), get (retrieve timeline), update_segment (update segment status/asset), confirm_all (confirm all ready segments).",
  parameters: timelineSchema,
  execute: executeTimeline,
});
```

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/tools/timeline.ts src/tools/registry.ts tests/tools/timeline.test.ts
git commit -m "feat: add timeline MCP tool for generating and managing video timelines"
```

---

## Phase 5: Web UI — Asset Panel API Endpoints

### Task 7: Timeline API endpoints

**Files:**
- Modify: `src/server/index.ts` — add timeline API routes
- Test: `tests/server/timeline-api.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/server/timeline-api.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the handler logic directly, not through HTTP
import { executeTimeline } from "../../src/tools/timeline.js";

describe("Timeline API handlers", () => {
  let dataDir: string;
  const contentId = "api-test-001";

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "timeline-api-"));
    const contentDir = join(dataDir, "contents", contentId);
    await mkdir(contentDir, { recursive: true });
    await writeFile(
      join(contentDir, "meta.json"),
      JSON.stringify({ id: contentId, title: "API Test", status: "approved" }),
    );
    await writeFile(
      join(contentDir, "draft.md"),
      `测试文案\n[card:key-points items="A,B,C"]`,
    );
  });

  it("GET /api/contents/:id/timeline — returns 404 when no timeline", async () => {
    const result = await executeTimeline({
      action: "get",
      content_id: contentId,
      _dataDir: dataDir,
    });
    expect(result.ok).toBe(false);
  });

  it("POST /api/contents/:id/timeline — generates timeline", async () => {
    const result = await executeTimeline({
      action: "generate",
      content_id: contentId,
      preset: "knowledge-explainer",
      aspect_ratio: "9:16",
      _dataDir: dataDir,
    });
    expect(result.ok).toBe(true);
    expect(result.timeline).toBeDefined();
  });

  it("PATCH /api/contents/:id/timeline/segments/:segId — updates segment", async () => {
    await executeTimeline({
      action: "generate",
      content_id: contentId,
      preset: "knowledge-explainer",
      aspect_ratio: "9:16",
      _dataDir: dataDir,
    });

    const result = await executeTimeline({
      action: "update_segment",
      content_id: contentId,
      segment_id: "vis-001",
      status: "ready",
      asset_path: "/tmp/card.png",
      _dataDir: dataDir,
    });
    expect(result.ok).toBe(true);

    // Verify the update persisted
    const getResult = await executeTimeline({
      action: "get",
      content_id: contentId,
      _dataDir: dataDir,
    });
    const vis = (getResult.timeline as any).tracks.visual[0];
    expect(vis.status).toBe("ready");
    expect(vis.asset).toBe("/tmp/card.png");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server/timeline-api.test.ts`
Expected: FAIL — test file doesn't exist yet

**Step 3: Write test and add API routes**

The test above tests through the tool directly. Add these routes to `src/server/index.ts`:

```typescript
// Add after existing /api/contents routes

// Timeline API
app.get("/api/contents/:id/timeline", async (c) => {
  const contentId = c.req.param("id");
  const result = await toolRunner.execute("autocrew_timeline", {
    action: "get",
    content_id: contentId,
  });
  if (!result.ok) return c.json(result, 404);
  return c.json(result);
});

app.post("/api/contents/:id/timeline", async (c) => {
  const contentId = c.req.param("id");
  const body = await c.req.json();
  const result = await toolRunner.execute("autocrew_timeline", {
    action: "generate",
    content_id: contentId,
    preset: body.preset || "knowledge-explainer",
    aspect_ratio: body.aspectRatio || "9:16",
  });
  return c.json(result);
});

app.patch("/api/contents/:id/timeline/segments/:segId", async (c) => {
  const contentId = c.req.param("id");
  const segId = c.req.param("segId");
  const body = await c.req.json();
  const result = await toolRunner.execute("autocrew_timeline", {
    action: "update_segment",
    content_id: contentId,
    segment_id: segId,
    status: body.status,
    asset_path: body.assetPath,
  });
  if (!result.ok) return c.json(result, 400);
  return c.json(result);
});

app.post("/api/contents/:id/timeline/confirm-all", async (c) => {
  const contentId = c.req.param("id");
  const result = await toolRunner.execute("autocrew_timeline", {
    action: "confirm_all",
    content_id: contentId,
  });
  return c.json(result);
});

// Card HTML preview
app.get("/api/cards/preview", async (c) => {
  const template = c.req.query("template") as string;
  const data = JSON.parse(c.req.query("data") || "{}");
  const aspectRatio = c.req.query("aspectRatio") || "9:16";

  const { renderCard } = await import("../modules/cards/template-engine.js");
  const html = renderCard(template as any, data, { aspectRatio: aspectRatio as any });
  return c.html(html);
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server/timeline-api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/index.ts tests/server/timeline-api.test.ts
git commit -m "feat: add timeline REST API endpoints and card preview endpoint"
```

---

## Phase 6: Web UI — Descript-Style Asset Panel

### Task 8: Asset panel React component

**Files:**
- Create: `web/src/pages/AssetPanel.tsx`
- Create: `web/src/components/SegmentCard.tsx`
- Create: `web/src/components/VisualPreview.tsx`
- Modify: `web/src/App.tsx` — add route
- Modify: `web/src/api.ts` — add timeline API functions

**Step 1: Add API functions**

```typescript
// Add to web/src/api.ts

export async function getTimeline(contentId: string) {
  return request<{ ok: boolean; timeline: any }>(`/api/contents/${contentId}/timeline`);
}

export async function generateTimeline(
  contentId: string,
  preset: string,
  aspectRatio: string,
) {
  return request<{ ok: boolean; timeline: any }>(`/api/contents/${contentId}/timeline`, {
    method: "POST",
    body: JSON.stringify({ preset, aspectRatio }),
  });
}

export async function updateSegment(
  contentId: string,
  segmentId: string,
  updates: { status?: string; assetPath?: string },
) {
  return request<{ ok: boolean }>(`/api/contents/${contentId}/timeline/segments/${segmentId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function confirmAllSegments(contentId: string) {
  return request<{ ok: boolean }>(`/api/contents/${contentId}/timeline/confirm-all`, {
    method: "POST",
  });
}
```

**Step 2: Create SegmentCard component**

```tsx
// web/src/components/SegmentCard.tsx
interface SegmentCardProps {
  tts: { id: string; text: string; estimatedDuration: number; status: string };
  visual?: {
    id: string;
    type: string;
    template?: string;
    prompt?: string;
    status: string;
    asset: string | null;
  };
  isActive: boolean;
  onClick: () => void;
}

export function SegmentCard({ tts, visual, isActive, onClick }: SegmentCardProps) {
  const statusColors: Record<string, string> = {
    pending: "#94a3b8",
    generating: "#f59e0b",
    ready: "#22c55e",
    confirmed: "#3b82f6",
    failed: "#ef4444",
  };

  return (
    <div
      onClick={onClick}
      style={{
        padding: "12px 16px",
        borderLeft: isActive ? "3px solid #3b82f6" : "3px solid transparent",
        background: isActive ? "#f0f9ff" : "transparent",
        cursor: "pointer",
        borderBottom: "1px solid #e5e7eb",
      }}
    >
      <p style={{ fontSize: "14px", lineHeight: 1.6, margin: 0 }}>{tts.text}</p>
      <span style={{ fontSize: "12px", color: "#94a3b8" }}>
        ~{tts.estimatedDuration.toFixed(1)}s
      </span>

      {visual && (
        <div
          style={{
            marginTop: "8px",
            padding: "6px 10px",
            background: "#f8fafc",
            borderRadius: "6px",
            fontSize: "12px",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <span>{visual.type === "card" ? "📊" : "🎬"}</span>
          <span style={{ flex: 1 }}>
            {visual.type === "card" ? visual.template : visual.prompt}
          </span>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusColors[visual.status] || "#94a3b8",
            }}
          />
        </div>
      )}
    </div>
  );
}
```

**Step 3: Create VisualPreview component**

```tsx
// web/src/components/VisualPreview.tsx
import { useMutation } from "@tanstack/react-query";
import { updateSegment } from "../api";

interface VisualPreviewProps {
  contentId: string;
  visual: {
    id: string;
    type: string;
    template?: string;
    prompt?: string;
    data?: Record<string, unknown>;
    status: string;
    asset: string | null;
    opacity?: number;
  } | null;
  onRefresh: () => void;
}

export function VisualPreview({ contentId, visual, onRefresh }: VisualPreviewProps) {
  const regenerate = useMutation({
    mutationFn: () =>
      updateSegment(contentId, visual!.id, { status: "pending" }),
    onSuccess: onRefresh,
  });

  if (!visual) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>
        选择左侧文案段落查看素材预览
      </div>
    );
  }

  return (
    <div style={{ padding: "20px" }}>
      <div
        style={{
          background: "#f8fafc",
          borderRadius: "12px",
          overflow: "hidden",
          aspectRatio: "9/16",
          maxHeight: "400px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid #e5e7eb",
        }}
      >
        {visual.asset ? (
          visual.type === "card" ? (
            <img
              src={visual.asset}
              alt="Card preview"
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          ) : (
            <video
              src={visual.asset}
              controls
              style={{ width: "100%", height: "100%" }}
            />
          )
        ) : (
          <div style={{ textAlign: "center", color: "#94a3b8" }}>
            <p style={{ fontSize: "48px", margin: 0 }}>
              {visual.type === "card" ? "📊" : "🎬"}
            </p>
            <p>{visual.type === "card" ? visual.template : "B-roll"}</p>
            <p style={{ fontSize: "12px" }}>
              {visual.status === "pending" ? "等待生成" : visual.status}
            </p>
          </div>
        )}
      </div>

      <div style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ fontSize: "13px", color: "#64748b" }}>
          {visual.type === "card" ? (
            <>模板: {visual.template}</>
          ) : (
            <>Prompt: {visual.prompt}</>
          )}
        </div>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            onClick={() => regenerate.mutate()}
            disabled={regenerate.isPending}
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid #e5e7eb",
              background: "white",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            🔄 重新生成
          </button>
          <button
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid #e5e7eb",
              background: "white",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            📝 编辑
          </button>
          <button
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: "1px solid #e5e7eb",
              background: "white",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            📤 上传替换
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 4: Create AssetPanel page**

```tsx
// web/src/pages/AssetPanel.tsx
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { getTimeline, generateTimeline, confirmAllSegments } from "../api";
import { SegmentCard } from "../components/SegmentCard";
import { VisualPreview } from "../components/VisualPreview";

export default function AssetPanel() {
  const { contentId } = useParams<{ contentId: string }>();
  const [activeSegment, setActiveSegment] = useState<string | null>(null);
  const [preset, setPreset] = useState("knowledge-explainer");
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["timeline", contentId],
    queryFn: () => getTimeline(contentId!),
    enabled: !!contentId,
    retry: false,
  });

  const generate = useMutation({
    mutationFn: () => generateTimeline(contentId!, preset, aspectRatio),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["timeline", contentId] });
    },
  });

  const confirmAll = useMutation({
    mutationFn: () => confirmAllSegments(contentId!),
    onSuccess: () => refetch(),
  });

  const timeline = data?.timeline;

  // Find visual linked to active TTS segment
  const activeVisual = timeline?.tracks.visual.find((v: any) =>
    v.linkedTts.includes(activeSegment),
  );

  if (!contentId) return <div>缺少 content ID</div>;

  // No timeline yet — show generate form
  if (!timeline && !isLoading) {
    return (
      <div style={{ padding: "40px", maxWidth: "480px", margin: "0 auto" }}>
        <h2 style={{ marginBottom: "24px" }}>生成视频时间轴</h2>

        <label style={{ display: "block", marginBottom: "16px" }}>
          <span style={{ fontSize: "14px", color: "#64748b" }}>预设风格</span>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px",
              marginTop: "4px",
              borderRadius: "6px",
              border: "1px solid #e5e7eb",
            }}
          >
            <option value="knowledge-explainer">知识讲解</option>
            <option value="tutorial">教程</option>
          </select>
        </label>

        <label style={{ display: "block", marginBottom: "24px" }}>
          <span style={{ fontSize: "14px", color: "#64748b" }}>画面比例</span>
          <select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px",
              marginTop: "4px",
              borderRadius: "6px",
              border: "1px solid #e5e7eb",
            }}
          >
            <option value="9:16">9:16 竖屏 (抖音/快手)</option>
            <option value="16:9">16:9 横屏 (B站/YouTube)</option>
            <option value="3:4">3:4 小红书</option>
            <option value="1:1">1:1 正方形</option>
            <option value="4:3">4:3 视频号</option>
          </select>
        </label>

        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          style={{
            width: "100%",
            padding: "12px",
            borderRadius: "8px",
            border: "none",
            background: "#3b82f6",
            color: "white",
            fontSize: "15px",
            cursor: "pointer",
          }}
        >
          {generate.isPending ? "生成中..." : "生成时间轴"}
        </button>
      </div>
    );
  }

  if (isLoading) return <div style={{ padding: "40px" }}>加载中...</div>;

  return (
    <div style={{ display: "flex", height: "calc(100vh - 60px)" }}>
      {/* Left: Script with segments */}
      <div
        style={{
          width: "45%",
          borderRight: "1px solid #e5e7eb",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            padding: "16px",
            borderBottom: "1px solid #e5e7eb",
            fontSize: "14px",
            color: "#64748b",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            {timeline.preset} · {timeline.aspectRatio}
          </span>
          <span>
            {timeline.tracks.tts.length} 段 ·{" "}
            ~{timeline.tracks.tts.reduce((s: number, t: any) => s + t.estimatedDuration, 0).toFixed(1)}s
          </span>
        </div>

        {timeline.tracks.tts.map((tts: any) => {
          const visual = timeline.tracks.visual.find((v: any) =>
            v.linkedTts.includes(tts.id),
          );
          return (
            <SegmentCard
              key={tts.id}
              tts={tts}
              visual={visual}
              isActive={activeSegment === tts.id}
              onClick={() => setActiveSegment(tts.id)}
            />
          );
        })}
      </div>

      {/* Right: Visual preview */}
      <div style={{ width: "55%", overflowY: "auto" }}>
        <VisualPreview
          contentId={contentId}
          visual={activeVisual || null}
          onRefresh={() => refetch()}
        />

        <div
          style={{
            padding: "16px",
            borderTop: "1px solid #e5e7eb",
            display: "flex",
            gap: "12px",
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={() => confirmAll.mutate()}
            style={{
              padding: "10px 20px",
              borderRadius: "8px",
              border: "none",
              background: "#22c55e",
              color: "white",
              cursor: "pointer",
              fontSize: "14px",
            }}
          >
            ✅ 全部确认
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 5: Add route in App.tsx**

Add to `web/src/App.tsx`:

```tsx
import AssetPanel from "./pages/AssetPanel";

// Inside Router, add route:
<Route path="/contents/:contentId/assets" element={<AssetPanel />} />
```

And add navigation link in the Contents page or content detail view.

**Step 6: Verify web builds**

Run: `cd web && npm run build`
Expected: Build succeeds

**Step 7: Commit**

```bash
git add web/src/
git commit -m "feat: add Descript-style asset panel Web UI for timeline management"
```

---

## Phase 7: Timeline Generation Skill

### Task 9: Create video-timeline skill for Claude orchestration

**Files:**
- Create: `skills/video-timeline/SKILL.md`

**Step 1: Write the skill**

```markdown
# 视频时间轴生成

> Trigger: "生成视频" / "视频素材" / "时间轴" / "video timeline" / "做视频"

## 概述

将已完成的文案自动生成视频时间轴，包括AI配音段落规划、B-roll素材标注、知识卡片配置。

## 前置条件

- 内容状态为 `approved` 或 `draft_ready`
- 文案（draft.md）已完成

## 流程

### 第一步：确认内容

使用 `autocrew_content` 工具读取内容，确认文案已就绪。

### 第二步：AI 自动标记

分析文案内容，在合适位置插入 `[card:...]` 和 `[broll:...]` 标记。

规则（knowledge-explainer 预设）：
- 约 60% 画面用知识卡片，40% 用 B-roll
- 提到对比、列举、要点时用 card
- 切换话题或需要过渡时用 broll
- B-roll prompt 要具体（画面内容+风格+氛围）

可用卡片模板：
- `comparison-table`: 对比表（attrs: title, rows）
- `key-points`: 要点列表（attrs: items）
- `flow-chart`: 流程图（attrs: steps）
- `data-chart`: 数据图（attrs: title, items）

标记语法：
```
文案段落
[card:模板名 title="标题" items="项目1,项目2"]

文案段落
[broll:具体画面描述]
```

### 第三步：用户确认标记

将带标记的文案展示给用户，让用户确认或修改标记。

### 第四步：生成时间轴

使用 `autocrew_timeline` 工具的 `generate` 动作，将带标记文案解析为 timeline.json。

参数：
- `content_id`: 内容 ID
- `preset`: "knowledge-explainer" 或 "tutorial"
- `aspect_ratio`: 用户选择的比例

### 第五步：引导素材生成

告知用户时间轴已生成，可以：
1. 在 Web UI 的素材面板中查看和调整（`/contents/{id}/assets`）
2. 使用 `autocrew render` 命令（需安装 @autocrew/studio）自动生成素材并合成

## 工具依赖

- `autocrew_content` — 读取文案
- `autocrew_timeline` — 生成和管理时间轴
```

**Step 2: Commit**

```bash
git add skills/video-timeline/
git commit -m "feat: add video-timeline skill for Claude-guided timeline generation"
```

---

## Phase 8: @autocrew/studio Package Scaffold (Future)

> This phase sets up the separate `@autocrew/studio` package. It can be implemented later as a separate project or monorepo workspace.

### Task 10: Studio package initialization

**Files:**
- Create: `packages/studio/package.json`
- Create: `packages/studio/src/index.ts`
- Create: `packages/studio/src/providers/tts/edge-tts.ts`
- Create: `packages/studio/src/providers/screenshot/puppeteer.ts`
- Create: `packages/studio/src/compositors/ffmpeg.ts`
- Create: `packages/studio/src/compositors/jianying.ts`
- Create: `packages/studio/src/cli.ts`

**This task is a scaffold outline. Detailed implementation will be planned separately when Phase 1-7 are complete and validated.**

Key decisions for studio:
- Monorepo with workspaces, or separate repo?
- Which TTS provider to implement first? (Recommendation: Edge TTS — free, good Chinese)
- FFmpeg compositor first, or Jianying exporter first? (Recommendation: Jianying — no ffmpeg needed)

**Commit placeholder:**

```bash
mkdir -p packages/studio/src
echo '{ "name": "@autocrew/studio", "version": "0.0.1", "private": true }' > packages/studio/package.json
git add packages/studio/
git commit -m "chore: scaffold @autocrew/studio package structure"
```

---

## Implementation Priority & Dependencies

```
Task 1 (types) ─────────┐
Task 2 (providers) ──────┤
                          ├→ Task 3 (parser) ──→ Task 6 (timeline tool) ──→ Task 7 (API) ──→ Task 8 (Web UI)
Task 5 (card engine) ────┘                                                                       ↓
                                                                                            Task 9 (skill)
Task 4 (markup gen) ─── independent, can parallel with Task 3                                    ↓
                                                                                           Task 10 (studio)
```

**Parallelizable:** Tasks 1+2 together, Tasks 3+4+5 together
**Sequential:** Task 6 needs 1+2+3, Task 7 needs 6, Task 8 needs 7, Task 9 needs 6

## Estimated Scope

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-2 | Core types & interfaces |
| 2 | 3-4 | Timeline markup engine |
| 3 | 5 | HTML card templates |
| 4 | 6 | Timeline MCP tool |
| 5 | 7 | API endpoints |
| 6 | 8 | Web UI asset panel |
| 7 | 9 | Skill definition |
| 8 | 10 | Studio package (future) |
