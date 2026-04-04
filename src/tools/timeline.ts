import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseMarkedScript } from "../modules/timeline/parser.js";
import type {
  VideoPreset,
  AspectRatio,
  SegmentStatus,
  Timeline,
} from "../types/timeline.js";

export const timelineSchema = Type.Object({
  action: Type.Unsafe<"generate" | "get" | "update_segment" | "confirm_all">({
    type: "string",
    enum: ["generate", "get", "update_segment", "confirm_all"],
    description:
      "generate: parse marked script into timeline.json. get: retrieve timeline. update_segment: update segment status/asset. confirm_all: confirm all ready segments.",
  }),
  content_id: Type.String({ description: "Content project ID" }),
  preset: Type.Optional(
    Type.Unsafe<VideoPreset>({
      type: "string",
      enum: ["knowledge-explainer", "tutorial"],
    }),
  ),
  aspect_ratio: Type.Optional(
    Type.Unsafe<AspectRatio>({
      type: "string",
      enum: ["9:16", "16:9", "3:4", "1:1", "4:3"],
    }),
  ),
  segment_id: Type.Optional(
    Type.String({ description: "Segment ID for update_segment" }),
  ),
  status: Type.Optional(
    Type.Unsafe<SegmentStatus>({
      type: "string",
      enum: ["pending", "generating", "ready", "confirmed", "failed"],
    }),
  ),
  asset_path: Type.Optional(
    Type.String({ description: "Path to generated asset file" }),
  ),
  _dataDir: Type.Optional(Type.String()),
});

function contentDir(dataDir: string, contentId: string): string {
  return join(dataDir, "contents", contentId);
}

function timelinePath(dataDir: string, contentId: string): string {
  return join(contentDir(dataDir, contentId), "timeline.json");
}

async function loadTimeline(
  dataDir: string,
  contentId: string,
): Promise<Timeline | null> {
  try {
    const raw = await readFile(timelinePath(dataDir, contentId), "utf-8");
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
  const dir = contentDir(dataDir, contentId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    timelinePath(dataDir, contentId),
    JSON.stringify(timeline, null, 2),
    "utf-8",
  );
}

export async function executeTimeline(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = params.action as string;
  const contentId = params.content_id as string;
  const dataDir = (params._dataDir as string) || "";

  if (!contentId) {
    return { ok: false, error: "content_id is required" };
  }

  if (action === "generate") {
    const preset = (params.preset as VideoPreset) || "knowledge-explainer";
    const aspectRatio = (params.aspect_ratio as AspectRatio) || "9:16";

    let script: string;
    try {
      script = await readFile(
        join(contentDir(dataDir, contentId), "draft.md"),
        "utf-8",
      );
    } catch {
      return {
        ok: false,
        error: `draft.md not found for content ${contentId}`,
      };
    }

    const timeline = parseMarkedScript(script, {
      contentId,
      preset,
      aspectRatio,
    });

    await saveTimeline(dataDir, contentId, timeline);

    return {
      ok: true,
      content_id: contentId,
      tts_count: timeline.tracks.tts.length,
      visual_count: timeline.tracks.visual.length,
      timeline,
    };
  }

  if (action === "get") {
    const timeline = await loadTimeline(dataDir, contentId);
    if (!timeline) {
      return {
        ok: false,
        error: `timeline.json not found for content ${contentId}`,
      };
    }
    return { ok: true, content_id: contentId, timeline };
  }

  if (action === "update_segment") {
    const segmentId = params.segment_id as string;
    if (!segmentId) {
      return { ok: false, error: "segment_id is required for update_segment" };
    }

    const timeline = await loadTimeline(dataDir, contentId);
    if (!timeline) {
      return {
        ok: false,
        error: `timeline.json not found for content ${contentId}`,
      };
    }

    const newStatus = params.status as SegmentStatus | undefined;
    const assetPath = params.asset_path as string | undefined;

    // Search across all track arrays
    let found = false;

    const newText = params.text as string | undefined;

    for (const seg of timeline.tracks.tts) {
      if (seg.id === segmentId) {
        if (newStatus) seg.status = newStatus;
        if (assetPath !== undefined) seg.asset = assetPath;
        if (newText !== undefined) seg.text = newText;
        found = true;
        break;
      }
    }

    if (!found) {
      for (const seg of timeline.tracks.visual) {
        if (seg.id === segmentId) {
          if (newStatus) seg.status = newStatus;
          if (assetPath !== undefined) seg.asset = assetPath;
          found = true;
          break;
        }
      }
    }

    if (!found) {
      return { ok: false, error: `Segment ${segmentId} not found` };
    }

    await saveTimeline(dataDir, contentId, timeline);

    // Sync text edits back to draft.md so regenerating timeline won't lose changes
    if (newText !== undefined) {
      const draftText = timeline.tracks.tts.map((s) => s.text).join("\n\n");
      await writeFile(
        join(contentDir(dataDir, contentId), "draft.md"),
        draftText,
        "utf-8",
      );
    }

    return { ok: true, content_id: contentId, segment_id: segmentId };
  }

  if (action === "confirm_all") {
    const timeline = await loadTimeline(dataDir, contentId);
    if (!timeline) {
      return {
        ok: false,
        error: `timeline.json not found for content ${contentId}`,
      };
    }

    let confirmed = 0;

    for (const seg of timeline.tracks.tts) {
      if (seg.status === "ready") {
        seg.status = "confirmed";
        confirmed++;
      }
    }

    for (const seg of timeline.tracks.visual) {
      if (seg.status === "ready") {
        seg.status = "confirmed";
        confirmed++;
      }
    }

    if (timeline.tracks.subtitle.status === "ready") {
      timeline.tracks.subtitle.status = "confirmed";
      confirmed++;
    }

    await saveTimeline(dataDir, contentId, timeline);
    return { ok: true, content_id: contentId, confirmed_count: confirmed };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}
