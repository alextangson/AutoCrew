import type {
  Timeline,
  TTSSegment,
  VisualSegment,
  VisualType,
  CardTemplate,
  VideoPreset,
  AspectRatio,
  SegmentStatus,
} from "../../types/timeline.js";

export interface ParseOptions {
  contentId: string;
  preset: VideoPreset;
  aspectRatio: AspectRatio;
}

interface ParsedCard {
  type: "card";
  template: string;
  attrs: Record<string, string>;
}

interface ParsedBroll {
  type: "broll";
  prompt: string;
  span: number;
}

type ParsedMarkup = ParsedCard | ParsedBroll;

const CARD_RE = /^\[card:([^\]]+)\]$/;
const BROLL_RE = /^\[broll:([^\]]+)\]$/;
const ATTR_RE = /(\w+)="([^"]*)"/g;
const BARE_ATTR_RE = /(\w+)=(\S+)/g;

function estimateDuration(text: string): number {
  let chineseCount = 0;
  let nonChineseCount = 0;

  for (const char of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(char)) {
      chineseCount++;
    } else if (/[a-zA-Z0-9]/.test(char)) {
      nonChineseCount++;
    }
  }

  const chineseSec = chineseCount / 4;
  const nonChineseSec = nonChineseCount / 15;
  return Math.max(chineseSec + nonChineseSec, 0.5);
}

function padId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

function parseCardContent(raw: string): ParsedCard {
  const parts = raw.trim();
  const firstSpace = parts.indexOf(" ");

  let template: string;
  let rest: string;

  if (firstSpace === -1) {
    template = parts;
    rest = "";
  } else {
    template = parts.slice(0, firstSpace);
    rest = parts.slice(firstSpace + 1);
  }

  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;

  // quoted attrs first
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(rest)) !== null) {
    attrs[match[1]] = match[2];
  }

  return { type: "card", template, attrs };
}

function parseBrollContent(raw: string): ParsedBroll {
  const trimmed = raw.trim();
  let span = 1;

  // extract bare attrs like span=2
  let prompt = trimmed;
  const spanMatch = /\bspan=(\d+)\b/.exec(trimmed);
  if (spanMatch) {
    span = parseInt(spanMatch[1], 10);
    prompt = trimmed.slice(0, spanMatch.index).trim();
    const after = trimmed.slice(spanMatch.index + spanMatch[0].length).trim();
    if (after) prompt = prompt ? `${prompt} ${after}` : after;
  }

  return { type: "broll", prompt, span };
}

function parseCardData(attrs: Record<string, string>): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (attrs.title) {
    data.title = attrs.title;
  }

  if (attrs.rows) {
    data.rows = attrs.rows.split(",").map((row) => {
      const parts = row.split(":");
      return { name: parts[0], pros: parts[1] ?? "", cons: parts[2] ?? "" };
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
  options: ParseOptions
): Timeline {
  const lines = script.split("\n");
  const ttsSegments: TTSSegment[] = [];
  const visualSegments: VisualSegment[] = [];

  // Accumulate text lines and pair them with following markup
  let textBuffer: string[] = [];
  let ttsCounter = 0;
  let visCounter = 0;
  let currentStart = 0;

  // Track which tts+layer combos are taken
  const layerMap = new Map<string, Set<number>>();

  function flushText(): string | null {
    if (textBuffer.length === 0) return null;
    const text = textBuffer.join("\n");
    textBuffer = [];
    return text;
  }

  function createTts(text: string): TTSSegment {
    ttsCounter++;
    const duration = estimateDuration(text);
    const seg: TTSSegment = {
      id: padId("tts", ttsCounter),
      text,
      estimatedDuration: parseFloat(duration.toFixed(2)),
      start: parseFloat(currentStart.toFixed(2)),
      asset: null,
      status: "pending" as SegmentStatus,
    };
    currentStart += duration;
    return seg;
  }

  function pickLayer(ttsIds: string[], preferredLayer: number): number {
    for (const ttsId of ttsIds) {
      const taken = layerMap.get(ttsId);
      if (taken?.has(preferredLayer)) {
        return preferredLayer + 1;
      }
    }
    return preferredLayer;
  }

  function markLayer(ttsIds: string[], layer: number): void {
    for (const ttsId of ttsIds) {
      if (!layerMap.has(ttsId)) layerMap.set(ttsId, new Set());
      layerMap.get(ttsId)!.add(layer);
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") continue;

    const cardMatch = CARD_RE.exec(trimmed);
    const brollMatch = BROLL_RE.exec(trimmed);

    if (cardMatch) {
      // Flush preceding text as TTS
      const text = flushText();
      if (text) {
        ttsSegments.push(createTts(text));
      }

      const parsed = parseCardContent(cardMatch[1]);
      const lastTtsId =
        ttsSegments.length > 0
          ? ttsSegments[ttsSegments.length - 1].id
          : null;
      const linkedTts = lastTtsId ? [lastTtsId] : [];

      const layer = pickLayer(linkedTts, 0);
      markLayer(linkedTts, layer);

      visCounter++;
      visualSegments.push({
        id: padId("vis", visCounter),
        layer,
        type: "card" as VisualType,
        template: parsed.template as CardTemplate,
        data: parseCardData(parsed.attrs),
        linkedTts,
        opacity: 0.85,
        asset: null,
        status: "pending" as SegmentStatus,
      });
    } else if (brollMatch) {
      // Flush preceding text as TTS
      const text = flushText();
      if (text) {
        ttsSegments.push(createTts(text));
      }

      const parsed = parseBrollContent(brollMatch[1]);
      const span = Math.min(parsed.span, ttsSegments.length);
      const linkedTts = ttsSegments
        .slice(-span)
        .map((s) => s.id);

      const layer = pickLayer(linkedTts, 0);
      markLayer(linkedTts, layer);

      visCounter++;
      visualSegments.push({
        id: padId("vis", visCounter),
        layer,
        type: "broll" as VisualType,
        prompt: parsed.prompt,
        linkedTts,
        asset: null,
        status: "pending" as SegmentStatus,
      });
    } else {
      textBuffer.push(trimmed);
    }
  }

  // Flush remaining text
  const remaining = flushText();
  if (remaining) {
    ttsSegments.push(createTts(remaining));
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
