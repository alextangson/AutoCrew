/**
 * render-exec.test.ts —— 渲染事务边界。
 * 假 render CLI 调**真 ffmpeg** 产出成片，所以这里的 ffprobe 断言是真断言：
 * 分辨率/帧率/音轨/时长任一不合格，都必须拦在「登记成 asset」之前。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listAssets } from "../../storage/local-store.js";
import { assertFinalVideo, finalVideoPath, runRenderJob, type RenderProgress } from "./render-exec.js";
import { fakeChild, fakeRenderSpawn, routedSpawn, seedVideoContent } from "./testkit.js";
import { videoDir } from "./video-store.js";

let dir: string;
let contentId: string;
let manifestFile: string;

const DURATION_MS = 2000;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-render-"));
  contentId = (await seedVideoContent(dir)).contentId;
  await fs.mkdir(videoDir(dir, contentId), { recursive: true });
  manifestFile = path.join(videoDir(dir, contentId), "render-manifest.v1.json");
  await fs.writeFile(manifestFile, JSON.stringify({ durationMs: DURATION_MS }));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function run(routes: Parameters<typeof routedSpawn>[0], onProgress?: (p: RenderProgress) => void) {
  return runRenderJob(
    { dataDir: dir, contentId, manifestFile, timelineRevision: 1, durationMs: DURATION_MS, ...(onProgress ? { onProgress } : {}) },
    { spawnImpl: routedSpawn(routes) },
  );
}

describe("runRenderJob", () => {
  it("渲染成功：断言通过 → 就位 → 登记为稿件 asset，tmp 不留", async () => {
    const progress: RenderProgress[] = [];
    const r = await run({ npm: fakeRenderSpawn() }, (p) => progress.push(p));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.file).toBe(finalVideoPath(dir, contentId, 1));
    await fs.access(r.file);
    await expect(fs.access(path.join(videoDir(dir, contentId), "final.v1.tmp.mp4"))).rejects.toThrow();
    expect(progress.at(-1)).toEqual({ renderedFrames: 60, totalFrames: 60 });

    const assets = await listAssets(contentId, dir);
    expect(assets.some((a) => a.filename === "final-v1.mp4" && a.type === "video")).toBe(true);
    await fs.access(path.join(dir, "contents", contentId, "assets", "final-v1.mp4"));
  });

  it("分辨率不对 → 断言拦下，产物改名 .failed 留档，绝不登记", async () => {
    const r = await run({ npm: fakeRenderSpawn({ width: 720, height: 1280 }) });
    expect(r.ok === false && r.errorCode).toBe("render_assert_failed");
    expect(r.ok === false && r.reason).toContain("720×1280");
    expect(r.ok === false && r.failedFile).toBeTruthy();
    await fs.access(path.join(videoDir(dir, contentId), "final.v1.failed.mp4"));
    expect((await listAssets(contentId, dir)).some((a) => a.filename.startsWith("final-"))).toBe(false);
  });

  it("没有音轨 → 断言拦下（哑片是「退出码 0」最典型的骗局）", async () => {
    const r = await run({ npm: fakeRenderSpawn({ noAudio: true }) });
    expect(r.ok === false && r.reason).toContain("没有音轨");
  });

  it("帧率不对 → 断言拦下", async () => {
    const r = await run({ npm: fakeRenderSpawn({ fps: 25 }) });
    expect(r.ok === false && r.reason).toContain("应为 30fps");
  });

  it("时长超出 ±0.5s 容差 → 断言拦下", async () => {
    const r = await run({ npm: fakeRenderSpawn({ durationDeltaMs: 1500 }) });
    expect(r.ok === false && r.reason).toContain("容差");
  });

  it("渲染进程非 0 退出 → render_failed，stderr 尾部进原因", async () => {
    const r = await run({ npm: fakeRenderSpawn({ exitCode: 1 }) });
    expect(r.ok === false && r.errorCode).toBe("render_failed");
    expect(r.ok === false && r.reason).toContain("假装崩了");
  });

  it("起不来渲染进程 → npm_missing，点名 workspace 位置", async () => {
    const r = await run({ npm: () => fakeChild({ spawnError: "spawn npm ENOENT" }) });
    expect(r.ok === false && r.errorCode).toBe("npm_missing");
    expect(r.ok === false && r.reason).toContain("render");
  });
});

describe("assertFinalVideo", () => {
  it("文件根本不是视频 → 问题清单非空", async () => {
    const junk = path.join(dir, "junk.mp4");
    await fs.writeFile(junk, "nope");
    expect(await assertFinalVideo(junk, DURATION_MS)).not.toHaveLength(0);
  });
});
