/**
 * assemble.test.ts —— 确定性组装 + 真 ffmpeg 双 pass 响度归一 + 冻结点。
 * loudnorm 不 mock：双 pass 的正确性只有真跑一遍才能证明。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assembleVideo,
  buildAnchorWav,
  buildDeterministicTimeline,
  DEFAULT_IDENTITY,
  loadIdentity,
  readOverlaySlots,
  writeOverlaySlots,
} from "./assemble.js";
import { ingestAroll } from "./ingest.js";
import { buildOutputMap } from "./output-map.js";
import { ensureArollFixture, fixtureTranscript, seedVideoContent } from "./testkit.js";
import { readVersioned, readVideoAssets, videoDir } from "./video-store.js";
import type { RenderManifest, VideoCut } from "./types.js";

let dir: string;
let contentId: string;
let arollPath: string;

const fullCut: VideoCut = { transcriptRevision: 1, keeps: ["seg-0001", "seg-0002"], flags: [], origin: "default_all" };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-assemble-"));
  const seeded = await seedVideoContent(dir);
  contentId = seeded.contentId;
  arollPath = seeded.arollPath;
  const ingested = await ingestAroll(dir, contentId);
  expect(ingested.ok).toBe(true);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function input(overrides?: Partial<Parameters<typeof assembleVideo>[0]>) {
  return {
    dataDir: dir,
    contentId,
    transcript: fixtureTranscript(),
    transcriptRevision: 1,
    cut: fullCut,
    cutRevision: 1,
    timelineRevision: 1,
    slots: [],
    ...overrides,
  };
}

describe("buildDeterministicTimeline", () => {
  it("V0a 形状固定：底轨 aroll + 逐词字幕 + 无标题卡 + 转场恒 cut", () => {
    const t = buildDeterministicTimeline({ transcriptRevision: 1, cutRevision: 2, overlays: [] });
    expect(t).toMatchObject({
      schemaVersion: 1,
      fps: 30,
      width: 1080,
      height: 1920,
      base: { type: "aroll" },
      anchor: { kind: "aroll", transcriptRevision: 1, cutRevision: 2 },
      captions: { style: "word-highlight" },
      audio: { anchorGainDb: 0 },
    });
    expect(t.titleCard).toBeUndefined();
    expect(t.overlays).toEqual([]);
  });

  it("覆盖轨按顺序编 clipId，screen 带 fit、image 不带", () => {
    const t = buildDeterministicTimeline({
      transcriptRevision: 1,
      cutRevision: 1,
      overlays: [
        { assetId: "a1", slot: { kind: "screen", ref: { kind: "content", filename: "s.mp4" }, outputStartMs: 0, durationMs: 500, fit: "contain" } },
        { assetId: "a2", slot: { kind: "image", ref: { kind: "content", filename: "i.png" }, outputStartMs: 600, durationMs: 300 } },
      ],
    });
    expect(t.overlays[0]).toMatchObject({ clipId: "clip-01", transition: "cut", source: { type: "screen", assetId: "a1", fit: "contain" } });
    expect(t.overlays[1]).toMatchObject({ clipId: "clip-02", source: { type: "image", assetId: "a2" } });
  });
});

describe("buildAnchorWav（真 ffmpeg 双 pass）", () => {
  it("按 keep 段拼接 + 归一，产出 wav 时长≈keep 总长", async () => {
    const map = buildOutputMap(fixtureTranscript(), fullCut);
    const out = path.join(dir, "anchor.wav");
    const r = await buildAnchorWav(arollPath, map, out);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // keep 段 1000ms + 1000ms = 2000ms
    expect(r.durationMs).toBeGreaterThan(1900);
    expect(r.durationMs).toBeLessThan(2100);
    expect((await fs.stat(out)).size).toBeGreaterThan(1000);
  });

  it("单段也走得通（不该为了 concat 而 concat）", async () => {
    const map = buildOutputMap(fixtureTranscript(), { ...fullCut, keeps: ["seg-0002"] });
    const r = await buildAnchorWav(arollPath, map, path.join(dir, "one.wav"));
    expect(r.ok && r.durationMs).toBeGreaterThan(900);
    expect(r.ok && r.durationMs).toBeLessThan(1100);
  });

  it("源文件不在 → 失败可见，不留半个 wav", async () => {
    const map = buildOutputMap(fixtureTranscript(), fullCut);
    const out = path.join(dir, "gone.wav");
    const r = await buildAnchorWav(path.join(dir, "nope.mp4"), map, out);
    expect(r.ok).toBe(false);
    await expect(fs.access(out)).rejects.toThrow();
  });
});

describe("loadIdentity", () => {
  it("没配过 → 用默认字幕主题", async () => {
    expect(await loadIdentity(dir)).toEqual(DEFAULT_IDENTITY);
  });

  it("配了就用配的，且只挑认识的字段（render 侧 schema 是 strict）", async () => {
    await fs.writeFile(
      path.join(dir, "video-identity.json"),
      JSON.stringify({
        captionTheme: { primaryColor: "#000000", emphasisColor: "#FF0000", 乱七八糟: 1 },
        codeTheme: { background: "#111111" },
        另一个不认识的字段: true,
      }),
    );
    const identity = await loadIdentity(dir);
    expect(identity.captionTheme).toEqual({ fontFamily: "PingFang SC", primaryColor: "#000000", emphasisColor: "#FF0000" });
    expect(identity.codeTheme).toEqual({ background: "#111111" });
    expect(JSON.stringify(identity)).not.toContain("乱七八糟");
  });
});

describe("assembleVideo", () => {
  it("一路到冻结：timeline / anchor / render-manifest 三件产物齐全且字段对得上", async () => {
    const r = await assembleVideo(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const timeline = await readVersioned(videoDir(dir, contentId), "timeline", 1);
    expect(timeline).toMatchObject({ base: { type: "aroll" }, captions: { style: "word-highlight" } });
    await fs.access(path.join(videoDir(dir, contentId), "anchor.v1.wav"));

    const m = (await readVersioned<RenderManifest>(videoDir(dir, contentId), "render-manifest", 1))!;
    expect(m).toMatchObject({
      schemaVersion: 1,
      contentId,
      fps: 30,
      width: 1080,
      height: 1920,
      durationMs: 2000,
      timelineRevision: 1,
      cutRevision: 1,
      transcriptRevision: 1,
      provenance: { hasAiClips: false, hasClonedVoice: false },
      identity: DEFAULT_IDENTITY,
    });
    expect(m.arollVideo.file).toBe(arollPath);
    expect(m.arollVideo.segments).toEqual([
      { sourceStartMs: 0, sourceEndMs: 1000, outputStartMs: 0 },
      { sourceStartMs: 1500, sourceEndMs: 2500, outputStartMs: 1000 },
    ]);
    expect(path.isAbsolute(m.anchorAudio.file)).toBe(true);
  });

  it("字幕词已投影到输出域（第二段整体前移 500ms）", async () => {
    const r = await assembleVideo(input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const words = r.manifest.captions.words;
    expect(words[0]).toEqual({ w: "今", startMs: 0, endMs: 200 });
    expect(words[3]).toEqual({ w: "这", startMs: 1000, endMs: 1300 });
    expect(words.every((w) => w.endMs <= r.manifest.durationMs)).toBe(true);
  });

  it("人工覆盖轨：素材被登记、manifest 里是解析好的绝对路径", async () => {
    const fixture = await ensureArollFixture();
    const screen = path.join(dir, "contents", contentId, "assets", "screen.mp4");
    await fs.copyFile(fixture, screen);
    const slots = [{ kind: "screen" as const, ref: { kind: "content" as const, filename: "screen.mp4" }, outputStartMs: 200, durationMs: 800, fit: "cover" as const }];
    const r = await assembleVideo(input({ slots }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.overlays).toHaveLength(1);
    expect(r.manifest.overlays[0]).toMatchObject({ clipId: "clip-01", kind: "screen", file: screen, fit: "cover", transition: "cut" });
    expect((await readVideoAssets(dir, contentId)).some((a) => a.kind === "screen" && a.status === "ready")).toBe(true);
  });

  it("覆盖轨越界 → timeline 校验拦下（不合法的 timeline 绝不落盘）", async () => {
    const fixture = await ensureArollFixture();
    await fs.copyFile(fixture, path.join(dir, "contents", contentId, "assets", "screen.mp4"));
    const slots = [{ kind: "screen" as const, ref: { kind: "content" as const, filename: "screen.mp4" }, outputStartMs: 1800, durationMs: 5000 }];
    const r = await assembleVideo(input({ slots }));
    expect(r.ok === false && r.errorCode).toBe("timeline_invalid");
    expect(await readVersioned(videoDir(dir, contentId), "timeline", 1)).toBeNull();
  });

  it("覆盖轨素材文件不在 → 组装前就说清楚", async () => {
    const slots = [{ kind: "image" as const, ref: { kind: "content" as const, filename: "missing.png" }, outputStartMs: 0, durationMs: 500 }];
    const r = await assembleVideo(input({ slots }));
    expect(r.ok === false && r.errorCode).toBe("overlay_asset_unusable");
  });

  it("一句都没留 → empty_cut，指引回选段", async () => {
    const r = await assembleVideo(input({ cut: { ...fullCut, keeps: [] } }));
    expect(r.ok === false && r.errorCode).toBe("empty_cut");
  });

  it("keeps 引用不存在的分句 → cut_invalid", async () => {
    const r = await assembleVideo(input({ cut: { ...fullCut, keeps: ["seg-9999"] } }));
    expect(r.ok === false && r.errorCode).toBe("cut_invalid");
  });

  it("A-roll 被改动 → blocked: aroll_drifted（引用不复制的代价在这儿还）", async () => {
    await fs.appendFile(arollPath, Buffer.alloc(4096, 7));
    const r = await assembleVideo(input());
    expect(r.ok === false && r.blockedReason).toBe("aroll_drifted");
    expect(r.ok === false && r.reason).toContain("对不上");
  });

  it("同一 timeline revision 不许重写（版本化产物是审计凭证）", async () => {
    expect((await assembleVideo(input())).ok).toBe(true);
    await expect(assembleVideo(input())).rejects.toThrow(/不可覆盖/);
  });
});

describe("覆盖轨槽位存取", () => {
  it("写过就读得回来，没写过 = 空数组", async () => {
    expect(await readOverlaySlots(dir, contentId, 3)).toEqual([]);
    const slots = [{ kind: "image" as const, ref: { kind: "video" as const, file: "x.png" }, outputStartMs: 0, durationMs: 100 }];
    await writeOverlaySlots(dir, contentId, 3, slots);
    expect(await readOverlaySlots(dir, contentId, 3)).toEqual(slots);
  });
});
