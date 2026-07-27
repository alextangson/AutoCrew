/**
 * ingest.test.ts —— 前置校验 + 真 ffprobe 探测 + 指纹登记。
 * 探测走真 ffprobe；只有「造真文件太贵」的规则（>30 分钟）用假报文测。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveContent, updateContent, addAsset } from "../../storage/local-store.js";
import {
  checkVideoEligibility,
  ingestAroll,
  MAX_AROLL_MS,
  probeAroll,
  probeMedia,
  resolveArollRef,
} from "./ingest.js";
import { fakeChild, fakeFfprobe, routedSpawn, seedVideoContent, ensureArollFixture } from "./testkit.js";
import { readVideoAssets } from "./video-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-ingest-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("checkVideoEligibility", () => {
  it("approved 的视频平台稿件放行", async () => {
    const { contentId } = await seedVideoContent(dir);
    expect((await checkVideoEligibility(contentId, dir)).ok).toBe(true);
  });

  it("published 也放行——已发的内容允许重剪", async () => {
    const { contentId } = await seedVideoContent(dir, { status: "published" });
    expect((await checkVideoEligibility(contentId, dir)).ok).toBe(true);
  });

  it("未定稿 → 拒，原因点名当前状态", async () => {
    const { contentId } = await seedVideoContent(dir, { status: "draft_ready" });
    const r = await checkVideoEligibility(contentId, dir);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("draft_ready");
  });

  it("非视频平台 → 拒", async () => {
    const c = await saveContent({ title: "t", body: "b", platform: "wechat_mp", status: "approved", tags: [], hashtags: [] }, dir);
    const r = await checkVideoEligibility(c.id, dir);
    expect(r.ok === false && r.reason).toContain("只服务视频平台");
  });

  it("回收站里的稿件 → 拒", async () => {
    const { contentId } = await seedVideoContent(dir);
    await updateContent(contentId, { deletedAt: new Date().toISOString() }, dir);
    const r = await checkVideoEligibility(contentId, dir);
    expect(r.ok === false && r.reason).toContain("回收站");
  });

  it("稿件不存在 → 拒", async () => {
    const r = await checkVideoEligibility("content-1-nope", dir);
    expect(r.ok === false && r.reason).toContain("不存在");
  });
});

describe("probeMedia / probeAroll（真 ffprobe）", () => {
  it("3 秒夹具：读出容器、时长、分辨率、音视频轨", async () => {
    const fixture = await ensureArollFixture();
    const r = await probeMedia(fixture);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.probe.durationMs).toBeGreaterThan(2800);
    expect(r.probe.durationMs).toBeLessThan(3200);
    expect(r.probe.video).toMatchObject({ codec: "h264", width: 640, height: 360 });
    expect(r.probe.video?.fps).toBeCloseTo(30, 1);
    expect(r.probe.audio?.codec).toBe("aac");
  });

  it("纯音频文件 → 拒收并说清「没有画面轨」", async () => {
    const wav = path.join(dir, "audio-only.wav");
    const { runProcess } = await import("./proc.js");
    await runProcess({
      command: "ffmpeg",
      args: ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav],
      timeoutMs: 30_000,
    });
    const r = await probeAroll(wav);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("没有画面轨");
  });

  it("损坏文件 → probe_failed，原因带 ffprobe 的话", async () => {
    const junk = path.join(dir, "broken.mp4");
    await fs.writeFile(junk, "not a video at all");
    const r = await probeAroll(junk);
    expect(r.ok === false && r.errorCode).toBe("probe_failed");
  });

  it(">30 分钟 → 拒收（用假报文，别真渲一个半小时的文件）", async () => {
    const spawnImpl = routedSpawn({
      ffprobe: fakeFfprobe({
        format: { format_name: "mov,mp4", duration: String(MAX_AROLL_MS / 1000 + 60) },
        streams: [
          { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, r_frame_rate: "30/1" },
          { codec_type: "audio", codec_name: "aac" },
        ],
      }),
    });
    const r = await probeAroll("/tmp/whatever.mp4", { spawnImpl });
    expect(r.ok === false && r.reason).toContain("超过 30 分钟上限");
  });

  it("ffprobe 不在 → ffmpeg_missing + 装法指引", async () => {
    const spawnImpl = routedSpawn({ ffprobe: () => fakeChild({ spawnError: "spawn ffprobe ENOENT" }) });
    const r = await probeMedia("/tmp/x.mp4", { spawnImpl });
    expect(r.ok === false && r.errorCode).toBe("ffmpeg_missing");
    expect(r.ok === false && r.reason).toContain("brew install ffmpeg");
  });
});

describe("ingestAroll", () => {
  it("稿件素材里的视频被认成 A-roll，指纹登记进 assets.json", async () => {
    const { contentId, arollPath } = await seedVideoContent(dir);
    const r = await ingestAroll(dir, contentId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.absPath).toBe(arollPath);
    const assets = await readVideoAssets(dir, contentId);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ kind: "aroll", status: "ready" });
    expect(assets[0].fingerprint?.quickHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("重复 ingest 复用同一个 assetId（timeline 里的引用不能因重登记而失效）", async () => {
    const { contentId } = await seedVideoContent(dir);
    const first = await ingestAroll(dir, contentId);
    const second = await ingestAroll(dir, contentId);
    expect(first.ok && second.ok && first.entry.assetId).toBe(second.ok ? second.entry.assetId : "x");
    expect(await readVideoAssets(dir, contentId)).toHaveLength(1);
  });

  it("没有素材 → aroll_missing，指引人去加素材", async () => {
    const c = await saveContent({ title: "t", body: "b", platform: "douyin", status: "approved", tags: [], hashtags: [] }, dir);
    const r = await ingestAroll(dir, c.id);
    expect(r.ok === false && r.errorCode).toBe("aroll_missing");
    expect(r.ok === false && r.reason).toContain("素材");
  });

  it("成片 final-v*.mp4 不会被当成 A-roll（否则第二次构建会剪上一版成片）", async () => {
    const c = await saveContent({ title: "t", body: "b", platform: "douyin", status: "approved", tags: [], hashtags: [] }, dir);
    const fixture = await ensureArollFixture();
    await fs.mkdir(path.join(dir, "contents", c.id, "assets"), { recursive: true });
    await addAsset(c.id, { filename: "final-v1.mp4", type: "video", sourcePath: fixture }, dir);
    expect(await resolveArollRef(dir, c.id)).toBeNull();
  });
});
