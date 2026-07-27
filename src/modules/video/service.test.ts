/**
 * service.test.ts —— 门面契约与全链状态走查。
 * 一条 content 从 startBuild 走到 done：每一步的 phase/state、产物版本链、乐观锁、事件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listAssets, saveContent } from "../../storage/local-store.js";
import { createVideoService, VideoConflictError, type VideoService } from "./service.js";
import { fakeRenderSpawn, fakeUvSpawn, routedSpawn, seedVideoContent } from "./testkit.js";
import { readVersioned, videoDir } from "./video-store.js";
import type { RenderManifest, VideoCut, VideoState } from "./types.js";

let dir: string;
let contentId: string;
let events: string[];
let service: VideoService;

const SETTLED = new Set(["awaiting_human", "failed", "blocked", "done", "idle"]);

function describeState(s: VideoState): string {
  const suffix = s.state === "failed" || s.state === "blocked" ? `(${s.errorCode}: ${s.failReason})` : "";
  return `${s.phase}/${s.state}${suffix}`;
}

/** 等管线跑到一个「不会再自己动」的状态；失败/阻塞时把原因带进断言消息 */
async function settled(): Promise<VideoState> {
  await expect
    .poll(async () => SETTLED.has((await service.getStatus(contentId))?.state.state ?? ""), { timeout: 60_000, interval: 40 })
    .toBe(true);
  return (await service.getStatus(contentId))!.state;
}

function build(routes?: Parameters<typeof routedSpawn>[0]): VideoService {
  return createVideoService({
    dataDir: dir,
    deps: { spawnImpl: routedSpawn(routes ?? { uv: fakeUvSpawn("ok"), npm: fakeRenderSpawn() }) },
    onEvent: (e) => events.push(e.contentId),
    onError: () => {},
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-service-"));
  contentId = (await seedVideoContent(dir)).contentId;
  events = [];
  service = build();
});

afterEach(async () => {
  await service.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("startBuild", () => {
  it("不合格的稿件直接拒（抛人话错误，不留半个状态）", async () => {
    const c = await saveContent({ title: "t", body: "b", platform: "wechat_mp", status: "approved", tags: [], hashtags: [] }, dir);
    await expect(service.startBuild(c.id)).rejects.toThrow(/只服务视频平台/);
    expect(await service.getStatus(c.id)).toBeNull();
  });

  it("投递即返回 queued，不等 ASR", async () => {
    const state = await service.startBuild(contentId);
    expect(describeState(state)).toBe("ingest/queued");
  });

  it("重复投递合并成一次，不重置进度", async () => {
    await service.startBuild(contentId);
    const first = await settled();
    const again = await service.startBuild(contentId);
    expect(describeState(again)).toBe(describeState(first));
    expect(again.revisions).toEqual(first.revisions);
  }, 60_000);
});

describe("全链走查", () => {
  it("startBuild → 转写 → 选段人工门 → 组装 → 渲染 → 审片 → done", async () => {
    await service.startBuild(contentId);
    const afterAsr = await settled();
    expect(describeState(afterAsr)).toBe("cut/awaiting_human");
    expect(afterAsr.revisions).toEqual({ transcript: 1, cut: 1 });

    // cut.v1 是全 keep 的默认决策，人只做减法
    const loaded = await service.getTranscript(contentId);
    expect(loaded?.cut).toMatchObject({ origin: "default_all", keeps: ["seg-0001", "seg-0002"] });
    expect(loaded?.transcript.scriptAlignment?.matchedRatio).toBeGreaterThan(0);

    const confirmed = await service.confirmCut(contentId, {
      keeps: ["seg-0001", "seg-0002"],
      flags: [{ segmentId: "seg-0002", flag: "repeat" }],
      baseTranscriptRevision: 1,
      baseCutRevision: 1,
    });
    expect(describeState(confirmed)).toBe("assemble/queued");

    const afterRender = await settled();
    expect(describeState(afterRender)).toBe("review/awaiting_human");
    expect(afterRender.revisions).toEqual({ transcript: 1, cut: 2, timeline: 1, rendered: 1 });

    // 冻结的 manifest 字段齐全，AI 标注判定走 false 路径
    const manifest = (await readVersioned<RenderManifest>(videoDir(dir, contentId), "render-manifest", 1))!;
    expect(manifest).toMatchObject({ cutRevision: 2, transcriptRevision: 1, durationMs: 2000, provenance: { hasAiClips: false, hasClonedVoice: false } });
    expect(manifest.captions.words.length).toBeGreaterThan(0);

    // 成片就位并登记回稿件素材
    await fs.access(path.join(videoDir(dir, contentId), "final.v1.mp4"));
    expect((await listAssets(contentId, dir)).some((a) => a.filename === "final-v1.mp4")).toBe(true);

    const done = await service.confirmReview(contentId, { renderedRevision: 1, verdict: "approve" });
    expect(describeState(done)).toBe("done/done");
    // 每次落盘都有事件（SSE 的源头）
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(new Set(events)).toEqual(new Set([contentId]));
  }, 90_000);

  it("打回 → 重剪 → 再渲染：revision 链一致且旧成片留档", async () => {
    await service.startBuild(contentId);
    await settled();
    await service.confirmCut(contentId, { keeps: ["seg-0001", "seg-0002"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 1 });
    await settled();

    const bounced = await service.confirmReview(contentId, { renderedRevision: 1, verdict: "reject" });
    expect(describeState(bounced)).toBe("cut/awaiting_human");

    const recut = await service.confirmCut(contentId, { keeps: ["seg-0001"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 });
    expect(describeState(recut)).toBe("assemble/queued");
    const after = await settled();
    expect(describeState(after)).toBe("review/awaiting_human");
    expect(after.revisions).toEqual({ transcript: 1, cut: 3, timeline: 2, rendered: 2 });

    const cut3 = await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 3);
    expect(cut3).toMatchObject({ origin: "human", baseCutRevision: 2, keeps: ["seg-0001"] });
    const m2 = (await readVersioned<RenderManifest>(videoDir(dir, contentId), "render-manifest", 2))!;
    expect(m2.cutRevision).toBe(3);
    expect(m2.durationMs).toBe(1000);
    // 旧成片不许被覆盖——「按哪版剪的」永远说得清
    await fs.access(path.join(videoDir(dir, contentId), "final.v1.mp4"));
    await fs.access(path.join(videoDir(dir, contentId), "final.v2.mp4"));
  }, 120_000);

  it("重开：done 的内容提交新选段直接重组装", async () => {
    await service.startBuild(contentId);
    await settled();
    await service.confirmCut(contentId, { keeps: ["seg-0001"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 1 });
    await settled();
    await service.confirmReview(contentId, { renderedRevision: 1, verdict: "approve" });

    const reopened = await service.confirmCut(contentId, { keeps: ["seg-0001", "seg-0002"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 2 });
    expect(describeState(reopened)).toBe("assemble/queued");
    expect(describeState(await settled())).toBe("review/awaiting_human");
  }, 120_000);
});

describe("乐观锁", () => {
  beforeEach(async () => {
    await service.startBuild(contentId);
    await settled();
  });

  it("base revision 过期 → VideoConflictError，状态不动", async () => {
    await expect(
      service.confirmCut(contentId, { keeps: ["seg-0001"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 0 }),
    ).rejects.toThrow(VideoConflictError);
    expect(describeState((await service.getStatus(contentId))!.state)).toBe("cut/awaiting_human");
  }, 60_000);

  it("引用不存在的分句 → 打回，不产出 cut", async () => {
    await expect(
      service.confirmCut(contentId, { keeps: ["seg-9999"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 1 }),
    ).rejects.toThrow(/不存在的分句/);
    expect(await readVersioned(videoDir(dir, contentId), "cut", 2)).toBeNull();
  }, 60_000);

  it("一句都不留 → 当场拒，不用等到组装才发现", async () => {
    await expect(
      service.confirmCut(contentId, { keeps: [], flags: [], baseTranscriptRevision: 1, baseCutRevision: 1 }),
    ).rejects.toThrow(/至少留一句/);
  }, 60_000);

  it("还没渲染就审片 → 拒", async () => {
    await expect(service.confirmReview(contentId, { renderedRevision: 1, verdict: "approve" })).rejects.toThrow(/还轮不到审片/);
  }, 60_000);

  it("审的不是当前那版成片 → VideoConflictError", async () => {
    await service.confirmCut(contentId, { keeps: ["seg-0001"], flags: [], baseTranscriptRevision: 1, baseCutRevision: 1 });
    await settled();
    await expect(service.confirmReview(contentId, { renderedRevision: 99, verdict: "approve" })).rejects.toThrow(VideoConflictError);
  }, 90_000);
});

describe("失败与重试", () => {
  it("ASR 崩了 → failed 带 failedPhase；retry 只重投那一步", async () => {
    await service.shutdown();
    service = build({ uv: fakeUvSpawn("crash"), npm: fakeRenderSpawn() });
    await service.startBuild(contentId);
    const failed = await settled();
    expect(failed).toMatchObject({ phase: "transcribe", state: "failed", failedPhase: "transcribe" });

    // 换成能跑通的 sidecar 再重试：从 transcribe 重来，不用从头 ingest
    await service.shutdown();
    service = build();
    const retried = await service.retry(contentId);
    expect(describeState(retried)).toBe("transcribe/queued");
    expect(describeState(await settled())).toBe("cut/awaiting_human");
  }, 90_000);

  it("blocked 也能重试（阻因消除后就该能继续）", async () => {
    await service.shutdown();
    service = build({ uv: fakeUvSpawn("model_missing"), npm: fakeRenderSpawn() });
    await service.startBuild(contentId);
    expect((await settled()).blockedReason).toBe("asr_not_ready");

    await service.shutdown();
    service = build();
    await service.retry(contentId);
    expect(describeState(await settled())).toBe("cut/awaiting_human");
  }, 90_000);

  it("没失败的时候点重试 → 拒（避免把跑着的任务重投一遍）", async () => {
    await service.startBuild(contentId);
    await settled();
    await expect(service.retry(contentId)).rejects.toThrow(/没有可重试的失败/);
  }, 60_000);
});

describe("查询口", () => {
  it("没开始剪 → getStatus/getTranscript 都是 null", async () => {
    expect(await service.getStatus(contentId)).toBeNull();
    expect(await service.getTranscript(contentId)).toBeNull();
  });

  it("getStatus 带上本条 content 的 job 视图", async () => {
    await service.startBuild(contentId);
    await settled();
    const status = (await service.getStatus(contentId))!;
    expect(status.jobs.every((j) => j.contentId === contentId)).toBe(true);
    expect(status.jobs.some((j) => j.phase === "transcribe" && j.status === "succeeded")).toBe(true);
  }, 60_000);

  it("ASR 预热状态可查", async () => {
    expect(await service.asrStatus()).toEqual({ status: "absent" });
    expect((await service.warmupAsr()).status).toBe("warming");
    await expect.poll(async () => (await service.asrStatus()).status, { timeout: 5000 }).toBe("ready");
  });
});
