import { describe, it, expect } from "vitest";
import type {
  Timeline,
  TTSSegment,
  VisualSegment,
  SubtitleTrack,
  SubtitleConfig,
  SegmentStatus,
  VideoPreset,
  AspectRatio,
  SubtitleTemplate,
  SubtitlePosition,
  VisualType,
  CardTemplate,
} from "./timeline.js";

describe("Timeline types", () => {
  it("creates a valid Timeline with all fields", () => {
    const tts: TTSSegment = {
      id: "tts-001",
      text: "Welcome to the tutorial",
      estimatedDuration: 3.5,
      start: 0,
      asset: null,
      status: "pending",
    };

    const visual: VisualSegment = {
      id: "vis-001",
      layer: 1,
      type: "broll",
      prompt: "city skyline at sunset",
      linkedTts: ["tts-001"],
      asset: null,
      status: "pending",
    };

    const subtitle: SubtitleTrack = {
      asset: null,
      status: "pending",
    };

    const timeline: Timeline = {
      version: "2.0",
      contentId: "content-abc",
      preset: "knowledge-explainer",
      aspectRatio: "9:16",
      subtitle: {
        template: "modern-outline",
        position: "bottom",
      },
      tracks: {
        tts: [tts],
        visual: [visual],
        subtitle,
      },
    };

    expect(timeline.version).toBe("2.0");
    expect(timeline.contentId).toBe("content-abc");
    expect(timeline.preset).toBe("knowledge-explainer");
    expect(timeline.aspectRatio).toBe("9:16");
    expect(timeline.subtitle.template).toBe("modern-outline");
    expect(timeline.subtitle.position).toBe("bottom");
    expect(timeline.tracks.tts).toHaveLength(1);
    expect(timeline.tracks.visual).toHaveLength(1);
    expect(timeline.tracks.subtitle.status).toBe("pending");
  });

  it("creates a card visual with template, data, and opacity", () => {
    const card: VisualSegment = {
      id: "vis-card-001",
      layer: 2,
      type: "card",
      template: "comparison-table",
      data: {
        headers: ["Feature", "Plan A", "Plan B"],
        rows: [["Price", "$10", "$20"]],
      },
      linkedTts: ["tts-001", "tts-002"],
      opacity: 0.85,
      asset: "cards/comparison.png",
      status: "ready",
    };

    expect(card.type).toBe("card");
    expect(card.template).toBe("comparison-table");
    expect(card.data).toBeDefined();
    expect(card.opacity).toBe(0.85);
    expect(card.asset).toBe("cards/comparison.png");
    expect(card.linkedTts).toEqual(["tts-001", "tts-002"]);
  });

  it("covers all valid SegmentStatus values", () => {
    const statuses: SegmentStatus[] = [
      "pending",
      "generating",
      "ready",
      "confirmed",
      "failed",
    ];

    expect(statuses).toHaveLength(5);

    for (const status of statuses) {
      const segment: TTSSegment = {
        id: "tts-test",
        text: "test",
        estimatedDuration: 1,
        start: 0,
        asset: null,
        status,
      };
      expect(segment.status).toBe(status);
    }
  });

  it("covers all VideoPreset values", () => {
    const presets: VideoPreset[] = ["knowledge-explainer", "tutorial"];
    expect(presets).toHaveLength(2);
  });

  it("covers all AspectRatio values", () => {
    const ratios: AspectRatio[] = ["9:16", "16:9", "3:4", "1:1", "4:3"];
    expect(ratios).toHaveLength(5);
  });

  it("covers all SubtitleTemplate values", () => {
    const templates: SubtitleTemplate[] = [
      "modern-outline",
      "karaoke-highlight",
      "minimal-fade",
      "bold-top",
    ];
    expect(templates).toHaveLength(4);
  });

  it("covers all CardTemplate values", () => {
    const templates: CardTemplate[] = [
      "comparison-table",
      "key-points",
      "flow-chart",
      "data-chart",
    ];
    expect(templates).toHaveLength(4);
  });
});
