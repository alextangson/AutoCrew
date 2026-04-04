import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTimeline } from "../../src/tools/timeline.js";

let dataDir: string;
const contentId = "content-tl-001";

const draftMd = `
这是开场白介绍内容
[card:comparison-table title="对比" rows="A:好:贵,B:便宜:差"]

这是第二段讲解
[broll:城市夜景霓虹灯]

这是结尾总结
`.trim();

async function setupContent(): Promise<void> {
  const dir = join(dataDir, "contents", contentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ id: contentId }));
  await writeFile(join(dir, "draft.md"), draftMd);
}

describe("executeTimeline", () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "autocrew-timeline-test-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("generates timeline from draft.md with markup", async () => {
    await setupContent();

    const result = await executeTimeline({
      action: "generate",
      content_id: contentId,
      preset: "knowledge-explainer",
      aspect_ratio: "9:16",
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(true);
    expect(result.content_id).toBe(contentId);
    expect(result.tts_count).toBe(3);
    expect(result.visual_count).toBe(2);

    const timeline = result.timeline as Record<string, unknown>;
    expect(timeline).toBeDefined();
    expect(timeline.version).toBe("2.0");
    expect(timeline.contentId).toBe(contentId);

    // Verify file was saved
    const saved = JSON.parse(
      await readFile(
        join(dataDir, "contents", contentId, "timeline.json"),
        "utf-8",
      ),
    );
    expect(saved.version).toBe("2.0");
    expect(saved.tracks.tts).toHaveLength(3);
  });

  it("gets existing timeline", async () => {
    await setupContent();

    // Generate first
    await executeTimeline({
      action: "generate",
      content_id: contentId,
      _dataDir: dataDir,
    });

    // Then get
    const result = await executeTimeline({
      action: "get",
      content_id: contentId,
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(true);
    const timeline = result.timeline as Record<string, unknown>;
    expect(timeline).toBeDefined();
    expect(timeline.contentId).toBe(contentId);
  });

  it("updates segment status and asset path", async () => {
    await setupContent();

    await executeTimeline({
      action: "generate",
      content_id: contentId,
      _dataDir: dataDir,
    });

    // Update a TTS segment
    const updateResult = await executeTimeline({
      action: "update_segment",
      content_id: contentId,
      segment_id: "tts-001",
      status: "ready",
      asset_path: "audio/tts-001.mp3",
      _dataDir: dataDir,
    });

    expect(updateResult.ok).toBe(true);
    expect(updateResult.segment_id).toBe("tts-001");

    // Verify persisted
    const getResult = await executeTimeline({
      action: "get",
      content_id: contentId,
      _dataDir: dataDir,
    });
    const timeline = getResult.timeline as {
      tracks: { tts: Array<{ id: string; status: string; asset: string | null }> };
    };
    const seg = timeline.tracks.tts.find((s) => s.id === "tts-001");
    expect(seg?.status).toBe("ready");
    expect(seg?.asset).toBe("audio/tts-001.mp3");
  });

  it("confirms all ready segments", async () => {
    await setupContent();

    await executeTimeline({
      action: "generate",
      content_id: contentId,
      _dataDir: dataDir,
    });

    // Set some segments to ready
    await executeTimeline({
      action: "update_segment",
      content_id: contentId,
      segment_id: "tts-001",
      status: "ready",
      _dataDir: dataDir,
    });
    await executeTimeline({
      action: "update_segment",
      content_id: contentId,
      segment_id: "vis-001",
      status: "ready",
      _dataDir: dataDir,
    });
    await executeTimeline({
      action: "update_segment",
      content_id: contentId,
      segment_id: "tts-002",
      status: "generating",
      _dataDir: dataDir,
    });

    const result = await executeTimeline({
      action: "confirm_all",
      content_id: contentId,
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(true);
    expect(result.confirmed_count).toBe(2);

    // Verify statuses
    const getResult = await executeTimeline({
      action: "get",
      content_id: contentId,
      _dataDir: dataDir,
    });
    const timeline = getResult.timeline as {
      tracks: {
        tts: Array<{ id: string; status: string }>;
        visual: Array<{ id: string; status: string }>;
      };
    };
    expect(timeline.tracks.tts[0].status).toBe("confirmed");
    expect(timeline.tracks.visual[0].status).toBe("confirmed");
    expect(timeline.tracks.tts[1].status).toBe("generating"); // unchanged
  });

  it("returns error for non-existent content (generate)", async () => {
    const result = await executeTimeline({
      action: "generate",
      content_id: "content-nonexistent",
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("draft.md not found");
  });

  it("returns error for non-existent content (get)", async () => {
    const result = await executeTimeline({
      action: "get",
      content_id: "content-nonexistent",
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeline.json not found");
  });

  it("returns error for non-existent segment", async () => {
    await setupContent();

    await executeTimeline({
      action: "generate",
      content_id: contentId,
      _dataDir: dataDir,
    });

    const result = await executeTimeline({
      action: "update_segment",
      content_id: contentId,
      segment_id: "tts-999",
      status: "ready",
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("tts-999");
  });

  it("returns error for missing content_id", async () => {
    const result = await executeTimeline({
      action: "generate",
      content_id: "",
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("content_id is required");
  });

  it("returns error for unknown action", async () => {
    const result = await executeTimeline({
      action: "unknown_action",
      content_id: contentId,
      _dataDir: dataDir,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown action");
  });
});
