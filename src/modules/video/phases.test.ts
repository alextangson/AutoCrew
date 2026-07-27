/**
 * phases.test.ts —— 单步执行体的直接单测（runner 那边测的是调度，这里测「一步之内做了什么」）。
 * 重点在两件事：产出的 next 状态与 revision 对不对；失败到底算 blocked 还是 failed。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executePhase, type PhaseContext } from "./phases.js";
import { ingestAroll } from "./ingest.js";
import { fakeUvSpawn, routedSpawn, seedVideoContent } from "./testkit.js";
import { readVersioned, readVideoAssets, videoDir } from "./video-store.js";
import type { VideoCut, VideoPhase, VideoState, VideoTranscript } from "./types.js";

let dir: string;
let contentId: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-phases-"));
  contentId = (await seedVideoContent(dir)).contentId;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function ctx(phase: VideoPhase, revisions: VideoState["revisions"] = {}, routes = { uv: fakeUvSpawn("ok") }): PhaseContext {
  return {
    dataDir: dir,
    contentId,
    state: { schemaVersion: 1, entryType: "aroll", phase, state: "running", revisions, updatedAt: new Date().toISOString() },
    deps: { spawnImpl: routedSpawn(routes) },
    abortSignal: new AbortController().signal,
  };
}

describe("executePhase 分派", () => {
  it("人工门阶段不是可执行阶段 → not_runnable（不静默停住）", async () => {
    const r = await executePhase(ctx("cut"));
    expect(r.ok === false && r.errorCode).toBe("not_runnable");
    expect(r.ok === false && r.reason).toContain("cut");
  });

  it("done 阶段同样不可执行", async () => {
    expect((await executePhase(ctx("done"))).ok).toBe(false);
  });
});

describe("ingest", () => {
  it("成功 → 自动接续到 transcribe/queued，素材登记完成", async () => {
    const r = await executePhase(ctx("ingest"));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "transcribe", state: "queued" });
    expect((await readVideoAssets(dir, contentId))[0]).toMatchObject({ kind: "aroll", status: "ready" });
  });
});

describe("transcribe", () => {
  it("成功 → cut 人工门 + transcript.v1 + cut.v1 全 keep + 对齐度已算", async () => {
    await ingestAroll(dir, contentId);
    const r = await executePhase(ctx("transcribe"));
    expect(r.ok).toBe(true);
    expect(r.ok && r.next).toEqual({ phase: "cut", state: "awaiting_human" });
    expect(r.ok && r.revisions).toEqual({ transcript: 1, cut: 1 });

    const transcript = await readVersioned<VideoTranscript>(videoDir(dir, contentId), "transcript", 1);
    expect(transcript?.scriptAlignment?.matchedRatio).toBeGreaterThan(0);
    const cut = await readVersioned<VideoCut>(videoDir(dir, contentId), "cut", 1);
    expect(cut).toMatchObject({ origin: "default_all", keeps: ["seg-0001", "seg-0002"] });
  });

  it("重跑转写 → revision 递增，旧版不动", async () => {
    await ingestAroll(dir, contentId);
    await executePhase(ctx("transcribe"));
    const r = await executePhase(ctx("transcribe", { transcript: 1, cut: 1 }));
    expect(r.ok && r.revisions).toEqual({ transcript: 2, cut: 2 });
    expect(await readVersioned(videoDir(dir, contentId), "transcript", 1)).not.toBeNull();
  });

  it("素材还没登记 → aroll_missing（failed，不是 blocked）", async () => {
    const r = await executePhase(ctx("transcribe"));
    expect(r.ok === false && r.errorCode).toBe("aroll_missing");
    expect(r.ok === false && r.blockedReason).toBeUndefined();
  });

  it("sidecar 未就绪 → blocked（阻塞与失败是两种命运）", async () => {
    await ingestAroll(dir, contentId);
    const r = await executePhase(ctx("transcribe", {}, { uv: fakeUvSpawn("model_missing") }));
    expect(r.ok === false && r.blockedReason).toBe("asr_not_ready");
  });
});

describe("assemble / render 的输入缺失", () => {
  it("读不到 transcript/cut → missing_input，点名版本号", async () => {
    await ingestAroll(dir, contentId);
    const r = await executePhase(ctx("assemble", { transcript: 7, cut: 9 }));
    expect(r.ok === false && r.errorCode).toBe("missing_input");
    expect(r.ok === false && r.reason).toContain("transcript.v7");
  });

  it("读不到 manifest → missing_manifest，指引重新组装", async () => {
    const r = await executePhase(ctx("render", { timeline: 3 }));
    expect(r.ok === false && r.errorCode).toBe("missing_manifest");
    expect(r.ok === false && r.reason).toContain("重新组装");
  });
});
