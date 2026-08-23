/**
 * preview-exec.test.ts —— 门内预览的事务边界与规格（v2 spec §4.1，边界 #5 / #6 / #16 / #17）。
 *
 * 假 render CLI 认 `--profile`，产物是**真 ffmpeg 出的 mp4**——所以这里的 ffprobe 断言
 * 是真断言，不是自问自答。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assembleVideo } from "./assemble.js";
import { ingestAroll } from "./ingest.js";
import {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  previewVideoPath,
  removePreviewOutputs,
  runPreviewJob,
  writePreviewRequest,
} from "./preview-exec.js";
import { fakeRenderSpawn, fixtureTranscript, routedSpawn, seedBgmAsset, seedVideoContent } from "./testkit.js";
import { videoDir, writeVersioned } from "./video-store.js";
import type { RenderManifest, VideoEditUnits, VideoPreviewRequest } from "./types.js";

let dir: string;
let contentId: string;

const KEEPS = ["seg-0001", "seg-0002"];

async function seed(): Promise<void> {
  contentId = (await seedVideoContent(dir)).contentId;
  const ingested = await ingestAroll(dir, contentId);
  if (!ingested.ok) throw new Error(`夹具导入失败：${ingested.reason}`);
  await writeVersioned(videoDir(dir, contentId), "transcript", 1, fixtureTranscript());
}

function input(over: Record<string, unknown> = {}) {
  return { dataDir: dir, contentId, revision: 1, keeps: KEEPS, transcriptRevision: 1, cutRevision: 1, ...over };
}

const deps = (over?: Parameters<typeof fakeRenderSpawn>[0]) => ({
  spawnImpl: routedSpawn({ npm: fakeRenderSpawn(over) }),
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-preview-"));
  await seed();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("writePreviewRequest —— 不可变请求", () => {
  it("按盘上最大号 +1 分配，内容含 keeps 与两个 base revision", async () => {
    const p1 = await writePreviewRequest(dir, contentId, { keeps: KEEPS, baseCutRevision: 1, baseTranscriptRevision: 1 });
    const p2 = await writePreviewRequest(dir, contentId, { keeps: ["seg-0001"], baseCutRevision: 1, baseTranscriptRevision: 1 });
    expect([p1, p2]).toEqual([1, 2]);
    const raw = JSON.parse(
      await fs.readFile(path.join(videoDir(dir, contentId), "cut-preview-request.v1.json"), "utf-8"),
    ) as VideoPreviewRequest;
    expect(raw).toMatchObject({ schemaVersion: 1, keeps: KEEPS, baseCutRevision: 1, baseTranscriptRevision: 1 });
    expect(raw.renderAlgoVersion).toBeTruthy();
  });

  it("**不写 cut revision**：草稿不污染 cut 语义", async () => {
    await writePreviewRequest(dir, contentId, { keeps: KEEPS, baseCutRevision: 1, baseTranscriptRevision: 1 });
    await expect(fs.access(path.join(videoDir(dir, contentId), "cut.v2.json"))).rejects.toThrow();
  });
});

describe("runPreviewJob", () => {
  it("跑通：产物就位、规格是 960×540、且不登记稿件 asset", async () => {
    const r = await runPreviewJob(input(), deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toBe(previewVideoPath(dir, contentId, 1));
    await fs.access(r.file);
    // 假 CLI 按 --profile 减半出片，这一步是真 ffprobe 断言（PREVIEW_WIDTH/HEIGHT 由它把关）
    expect([PREVIEW_WIDTH, PREVIEW_HEIGHT]).toEqual([960, 540]);
    // 预览绝不冒充成片：稿件 assets 目录里不该多出任何东西
    const assets = await fs.readdir(path.join(dir, "contents", contentId, "assets"));
    expect(assets.filter((f) => f.startsWith("preview"))).toEqual([]);
  }, 120_000);

  // 边界 #16 / #17：预览与正式共享 builder，只差 profile；BGM 按构造不可能出现
  it("预览 manifest：无 overlay、无标题卡、无 BGM，但有 anchor 与 cues", async () => {
    await seedBgmAsset(dir, contentId);
    const r = await runPreviewJob(input(), deps());
    expect(r.ok).toBe(true);
    const manifest = JSON.parse(
      await fs.readFile(path.join(videoDir(dir, contentId), "preview-manifest.v1.json"), "utf-8"),
    ) as RenderManifest;
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.overlays).toEqual([]);
    expect(manifest.titleCard).toBeUndefined();
    // 音轨恒指 anchor：master-audio 那条链路压根没被调用
    expect(path.basename(manifest.anchorAudio.file)).toMatch(/^preview-anchor\.v1\.wav$/);
    expect(manifest.captions.cues.length).toBeGreaterThan(0);
    // 尺寸契约仍是 1920×1080，减半由渲染档做
    expect([manifest.width, manifest.height]).toEqual([1920, 1080]);
  }, 120_000);

  it("cue 口径跟 edit-units.origin 走；units 传参优先于盘上那份（cut job 尾接时 staging 还没定版）", async () => {
    const units: VideoEditUnits = {
      schemaVersion: 1,
      transcriptRevision: 1,
      origin: "llm",
      segments: fixtureTranscript().segments,
      suggestedDrops: [],
      flags: [],
    };
    const r = await runPreviewJob(input({ units }), deps());
    expect(r.ok).toBe(true);
    const manifest = JSON.parse(
      await fs.readFile(path.join(videoDir(dir, contentId), "preview-manifest.v1.json"), "utf-8"),
    ) as RenderManifest;
    // llm 口径 = 一个单元一屏，两句转写 → 两块
    expect(manifest.captions.cues).toHaveLength(2);
  }, 120_000);

  // 边界 #5
  it("渲染失败 → 不留半截 mp4（媒体端点永远读不到没过断言的文件）", async () => {
    const r = await runPreviewJob(input(), deps({ exitCode: 1 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("preview_failed");
    await expect(fs.access(previewVideoPath(dir, contentId, 1))).rejects.toThrow();
    await expect(fs.access(path.join(videoDir(dir, contentId), "preview.v1.tmp.mp4"))).rejects.toThrow();
  }, 120_000);

  it("规格不对 → 断言拦下并说清差在哪，产物不就位", async () => {
    // 强制出 1920×1080：preview 档减半后仍不是 960×540
    const r = await runPreviewJob(input(), deps({ width: 3840, height: 2160 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("preview_assert_failed");
    expect(r.reason).toContain("960×540");
    await expect(fs.access(previewVideoPath(dir, contentId, 1))).rejects.toThrow();
  }, 120_000);

  // 边界 #6
  it("成功后删掉更老的预览，只留最新", async () => {
    expect((await runPreviewJob(input({ revision: 1 }), deps())).ok).toBe(true);
    expect((await runPreviewJob(input({ revision: 2 }), deps())).ok).toBe(true);
    const names = await fs.readdir(videoDir(dir, contentId));
    expect(names.filter((n) => /^preview\.v\d+\.mp4$/.test(n))).toEqual(["preview.v2.mp4"]);
    // 请求台账是审计凭证，不在清理范围里
    await fs.writeFile(path.join(videoDir(dir, contentId), "cut-preview-request.v1.json"), "{}");
    expect((await runPreviewJob(input({ revision: 3 }), deps())).ok).toBe(true);
    await fs.access(path.join(videoDir(dir, contentId), "cut-preview-request.v1.json"));
  }, 180_000);

  it("一句都没勾 → 人话拒绝，不去起渲染进程", async () => {
    const r = await runPreviewJob(input({ keeps: [] }), deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe("empty_cut");
    expect(r.reason).toContain("勾几句");
  });

  it("读不到转写 → missing_input（不是崩，是可显示的原因）", async () => {
    const r = await runPreviewJob(input({ transcriptRevision: 9 }), deps());
    expect(r.ok === false && r.errorCode).toBe("missing_input");
  });
});

// 边界 #16：预览与正式**共享同一个 manifest builder**，只差 profile 与「有没有 overlay/BGM/标题卡」。
// 这条不是靠人记得，而是靠这个用例锁住：两侧的时间映射与 cue 必须逐字相等。
describe("预览与正式不许长出两套时间映射", () => {
  it("同一版选段：段落投影与字幕 cue 在两份 manifest 里完全一致", async () => {
    const units: VideoEditUnits = {
      schemaVersion: 1,
      transcriptRevision: 1,
      origin: "llm",
      segments: fixtureTranscript().segments,
      suggestedDrops: [],
      flags: [],
    };
    await writeVersioned(videoDir(dir, contentId), "edit-units", 1, units);
    expect((await runPreviewJob(input(), deps())).ok).toBe(true);
    const preview = JSON.parse(
      await fs.readFile(path.join(videoDir(dir, contentId), "preview-manifest.v1.json"), "utf-8"),
    ) as RenderManifest;

    const assembled = await assembleVideo({
      dataDir: dir,
      contentId,
      transcript: fixtureTranscript(),
      transcriptRevision: 1,
      cut: { transcriptRevision: 1, keeps: KEEPS, flags: [], origin: "human" },
      cutRevision: 1,
      timelineRevision: 1,
      slots: [],
      unitsOrigin: "llm",
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    expect(preview.arollVideo.segments).toEqual(assembled.manifest.arollVideo.segments);
    expect(preview.captions).toEqual(assembled.manifest.captions);
    expect(preview.durationMs).toBe(assembled.manifest.durationMs);
    // 差别只在「预览不带 overlay / 标题卡」这一处，尺寸契约两边同样是 1920×1080
    expect([preview.width, preview.height]).toEqual([assembled.manifest.width, assembled.manifest.height]);
  }, 180_000);
});

/**
 * 边界 #12（lifecycle §3.3）：作废的预览**自己把输出收走**。
 * unlink 只防「正在读的人被拽掉文件」，不防「清理跑完之后一次迟到的 rename 把预览又变出来」——
 * 谁产出的谁负责收走，否则 done 之后磁盘上会莫名其妙冒出一个预览文件。
 */
describe("removePreviewOutputs（superseded 主动删自己的输出）", () => {
  it("只删指定那一版的全部产物，别版与别的文件一个字不动", async () => {
    const vdir = videoDir(dir, contentId);
    const files = [
      "preview.v2.mp4",
      "preview.v2.tmp.mp4",
      "preview-anchor.v2.wav",
      "preview-manifest.v2.json",
      "preview.v3.mp4",
      "final.v1.mp4",
    ];
    for (const name of files) await fs.writeFile(path.join(vdir, name), "x");

    await removePreviewOutputs(dir, contentId, 2);
    const left = await fs.readdir(vdir);
    expect(left).not.toContain("preview.v2.mp4");
    expect(left).not.toContain("preview.v2.tmp.mp4");
    expect(left).not.toContain("preview-anchor.v2.wav");
    expect(left).not.toContain("preview-manifest.v2.json");
    expect(left).toContain("preview.v3.mp4");
    expect(left).toContain("final.v1.mp4");
  });

  it("那一版本来就没有产物 → 什么都不做，也不抛", async () => {
    await expect(removePreviewOutputs(dir, contentId, 99)).resolves.toBeUndefined();
  });
});
